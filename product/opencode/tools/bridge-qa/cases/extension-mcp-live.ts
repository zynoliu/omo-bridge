import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { stageCompanionExtensionProfile } from "../../../packages/cli/src/bridge-agent-profile.ts";
import { pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import { createBridgeMcpExecutor } from "../../../packages/cli/src/bridge-mcp.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { createExtensionRequester } from "../../../packages/bridge-core/src/extension-request.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { connectBridgeMcp } from "../../../packages/tui/src/bridge/mcp-client.ts";
import { dataOf, openLiveHost, text } from "./live-host.ts";

/** The companion extension the launcher ships; the host loads its `.ts` entry directly. */
const EXTENSION_SOURCE = path.join(import.meta.dir, "..", "..", "..", "packages", "bridge-extension", "src");
const CONTAINER_EXTENSION_DIR = "/home/bridge/bridge-mcp/ext";
const CONTAINER_SETTINGS = "/home/bridge/.omo/agent/settings.json";

/**
 * N-MCP against the real host through the route the official image supports: `omo daemon run` reads
 * `<agentDir>/settings.json`, so the profile the host reads is written by the launcher's own staging
 * (`stageCompanionExtensionProfile`, the function `launchBridgeTui` calls before it dials). The case
 * seeds a setting the launcher does not own and asserts the entry was merged into it; the bytes the
 * host loads are therefore the product's, not a fixture's. The profile lives in a host temp dir and
 * the container; the worktree is only read.
 *
 * With the companion extension loaded the client-MCP channel is one loop through the shipped pieces:
 * `bridge.mcp.register` reaches the host's `registerMcpServer`, and `bridge.mcp.ping` makes the host
 * extension emit a `tui.pack.mcp.request` that the TUI client answers with `tui.pack.mcp.reply`; the
 * answer comes back to the extension and out as this request's result. An unknown extension request
 * stays refused, which is the control that the answers come from this handler, not a permissive host.
 */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  const detail: string[] = [];
  const profile = mkdtempSync(path.join(tmpdir(), "bridge-mcp-profile-"));
  const frames: Record<string, unknown>[] = [];
  const waiting = new Map<string, (frame: Record<string, unknown>) => void>();
  /** Subscribed before the request is written, so a fast host answer cannot land before the waiter. */
  const awaitResponse = (id: string, deadlineMs = 20_000) =>
    new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(undefined);
      }, deadlineMs);
      waiting.set(id, (frame) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(frame);
      });
    });

  try {
    for (const file of ["extension.ts", "host.ts", "mcp.ts"]) {
      copyFileSync(path.join(EXTENSION_SOURCE, file), path.join(profile, file));
    }
    /* The launcher owns this document. The case seeds a setting the launcher does not own and asks the
       launcher's staging to add the companion entry, so the host reads product output, not a fixture. */
    const agentProfile = path.join(profile, "agent");
    mkdirSync(agentProfile, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(agentProfile, "settings.json"),
      JSON.stringify({ defaultModel: "opencode-go/deepseek-v4.1-flash" }, null, 2) + "\n",
      { mode: 0o600 },
    );
    const staged = stageCompanionExtensionProfile({
      agentDir: agentProfile,
      extensionEntry: CONTAINER_EXTENSION_DIR + "/extension.ts",
    });
    record(
      "the-launcher-wrote-the-extension-profile",
      'action "updated" and the extension entry present in the document',
      text(staged),
      staged?.action === "updated" && staged.extensions.includes(CONTAINER_EXTENSION_DIR + "/extension.ts"),
    );
    const stagedDocument =
      staged === undefined ? {} : (JSON.parse(readFileSync(staged.path, "utf8")) as Record<string, unknown>);
    record(
      "the-profile-keeps-the-settings-it-did-not-own",
      "defaultModel survives and extensions carries exactly one entry",
      text(stagedDocument),
      stagedDocument.defaultModel === "opencode-go/deepseek-v4.1-flash" &&
        Array.isArray(stagedDocument.extensions) &&
        stagedDocument.extensions.length === 1,
    );
    if (staged === undefined) {
      detail.push("the launcher staged no profile, so the host cannot load the companion extension");
      return { checks: checks, cleanup: { ok: true, detail: detail } };
    }

    const host = await openLiveHost(
      "bridge-mcp-",
      (frame) => {
        if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
        const entry = frame as Record<string, unknown>;
        frames.push(entry);
        if (entry.type !== "response" || typeof entry.id !== "string") return;
        waiting.get(entry.id)?.(entry);
      },
      {
        prepare: (container, run) => {
          run(["exec", container, "mkdir", "-p", CONTAINER_EXTENSION_DIR, path.posix.dirname(CONTAINER_SETTINGS)]);
          for (const file of ["extension.ts", "host.ts", "mcp.ts"]) {
            run(["cp", path.join(profile, file), container + ":" + CONTAINER_EXTENSION_DIR + "/" + file]);
          }
          run(["cp", path.join(agentProfile, "settings.json"), container + ":" + CONTAINER_SETTINGS]);
          run([
            "exec",
            "-u",
            "root",
            container,
            "sh",
            "-c",
            "chown -R 10001:10001 " +
              CONTAINER_EXTENSION_DIR +
              " " +
              CONTAINER_SETTINGS +
              " && chmod -R a+rX " +
              CONTAINER_EXTENSION_DIR +
              " && chmod 0644 " +
              CONTAINER_SETTINGS,
          ]);
          detail.push(
            "copied the launcher-written " + CONTAINER_SETTINGS + " and the companion extension into " + container,
          );
        },
      },
    );
    if (host.kind === "blocked") {
      return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
    }
    try {
      const data = host.data;
      const routingById = new Map<string, string>();
      const opened = await host.ask("open_session", { cwd: "/work" });
      record("session-opened", "the host opens a session", text(opened, 100), opened.success === true);
      const outcome = await pullHostState(host.transport, data, new SessionRegistry());
      for (const status of outcome.statuses) routingById.set(status.durableId, status.routingId);
      const durable = outcome.sessionIds[0] ?? "";
      const routing = routingById.get(durable) ?? "";

      const written: unknown[] = [];
      const requester = createExtensionRequester({
        write: (frame) => {
          written.push(frame);
          host.transport.send(frame);
        },
      });
      data.setExtensionRequester(requester);
      data.subscribeEvents((frame) => {
        if (typeof frame !== "object" || frame === null) return;
        const id = "id" in frame ? (frame as { id?: unknown }).id : undefined;
        const type = "type" in frame ? (frame as { type?: unknown }).type : undefined;
        if (typeof id === "string" && type === "response") requester.accept(id, frame);
      });

      const client = connectBridgeMcp(data, {
        execute: createBridgeMcpExecutor(undefined),
        onError: (message) => detail.push("client MCP error: " + message),
        routeSession: (sessionID) => routingById.get(sessionID),
      });

      const register = await host.ask("extension_request", {
        sessionId: routing,
        name: "bridge.mcp.register",
        data: { servers: [{ name: "live-stdio", config: { type: "stdio", command: "/bin/echo", args: ["live"] } }] },
      });
      const registerData = dataOf(register);
      const registered = Array.isArray(registerData?.registered) ? (registerData.registered as unknown[]) : [];
      const refused = Array.isArray(registerData?.refused) ? (registerData.refused as unknown[]) : [];
      record(
        "the-host-loaded-the-companion-extension",
        'bridge.mcp.register answers registered:["live-stdio"] and no refusal',
        text(register, 240),
        registered.includes("live-stdio") && refused.length === 0,
      );

      const control = await host.ask("extension_request", { sessionId: routing, name: "no.such.extension.request", data: {} });
      record(
        "the-answers-come-from-the-extension's-own-handler",
        "a name no extension registered is still refused: Unknown extension RPC request",
        text(control, 160),
        String(control.error ?? "").includes("Unknown extension RPC request"),
      );

      const replyAnswer = awaitResponse("mcp-reply-live-1");
      data.publishEvent({
        type: "extension_event",
        name: "tui.pack.mcp.request",
        data: { requestId: "live-1", sessionId: durable, server: "tui", tool: "open_terminal", input: {} },
      });
      const answeredFrame = await replyAnswer;
      const frameRecord = typeof written[0] === "object" && written[0] !== null ? (written[0] as Record<string, unknown>) : {};
      record(
        "the-reply-is-written-to-the-host",
        "one extension_request named tui.pack.mcp.reply",
        text(written[0], 240),
        frameRecord.name === "tui.pack.mcp.reply" && frameRecord.type === "extension_request",
      );
      record(
        "the-reply-carries-this-connection's-routing-handle",
        routing + " rather than the extension's durable id",
        String(frameRecord.sessionId),
        routing.length > 0 && frameRecord.sessionId === routing && frameRecord.sessionId !== durable,
      );
      record(
        "the-executor's-answer-travels-in-the-frame",
        "the shipped executor's refusal, since this case runs no terminal service",
        text(frameRecord.data, 200),
        JSON.stringify(frameRecord.data ?? {}).includes("this bridge runs no terminal service"),
      );
      const replyData = dataOf(answeredFrame ?? {});
      record(
        "the-loaded-extension-received-the-reply",
        'accepted:false with reason "no request is waiting for live-1", not an Unknown-extension refusal',
        text(answeredFrame, 240),
        answeredFrame?.success === true && replyData?.accepted === false && String(replyData?.reason ?? "").includes("live-1"),
      );

      const ping = await host.ask("extension_request", {
        sessionId: routing,
        name: "bridge.mcp.ping",
        data: { sessionId: durable, server: "tui", tool: "open_terminal", input: {} },
      });
      const pingData = dataOf(ping);
      record(
        "a-host-initiated-client-MCP-request-round-trips",
        "bridge.mcp.ping returns the TUI executor's answer under its own ping id",
        text(ping, 260),
        String(pingData?.requestId ?? "").startsWith("ping-") &&
          String(pingData?.error ?? "").includes("this bridge runs no terminal service"),
      );

      const withoutSession = await host.ask("extension_request", { name: "tui.pack.mcp.reply", data: { requestId: "live-2" } });
      record(
        "the-routing-field-is-required-by-this-host",
        "missing_session_id without a sessionId",
        text(withoutSession, 120),
        String(withoutSession.error ?? "") === "missing_session_id",
      );

      const events = frames.filter((entry) => entry.type === "extension_event");
      record(
        "the-host-published-extension-events-on-this-channel",
        "at least one host extension_event reached the client",
        String(events.length) + " event frame(s)",
        events.length > 0,
      );

      client.stop();
      const afterStop = await host.ask("extension_request", {
        sessionId: routing,
        name: "tui.pack.mcp.reply",
        data: { requestId: "live-3", ok: false, error: "the client has stopped" },
      });
      const afterStopData = dataOf(afterStop);
      record(
        "the-loaded-extension-still-answers-after-the-client-stops",
        'accepted:false with a reason naming live-3',
        text(afterStop, 200),
        afterStop.success === true && String(afterStopData?.reason ?? "").includes("live-3"),
      );
    } catch (error) {
      record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
    } finally {
      detail.push(...(await host.close()));
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
