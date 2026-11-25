import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import { encodeHostResponseFrame } from "../../../packages/bridge-core/src/host-frames.ts";

/**
 * The user-visible approval flow: a model asks for a tool, the host raises the approval dialog to this
 * client, the client answers through the shipped encoder, and only then does the tool run.
 *
 * This is the path a TUI user actually takes, so every piece is the shipped one: the launcher's
 * transport, the bridge's `encodeHostResponseFrame`, and the host's own permission system under the
 * `ask` preset. The evidence that the tool ran is a token this case writes to the container and never
 * sends to the model: no frame can carry it before the approved tool's own result does.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";
const APPROVAL_TITLE = "Permission required:";
const MODEL = { provider: "opencode-go", modelId: "deepseek-v4.1-flash" };
const PROBE_FILE = "/work/approval-probe.txt";

type Frame = Record<string, unknown>;

export type ApprovalFacts = {
  /** One entry per approval dialog that reached this client, as the title's first line. */
  readonly asks: readonly string[];
  readonly firstAsk: number | undefined;
  /** Where the approved tool's own result carried the token, and which tool produced it. */
  readonly resultAt: number | undefined;
  readonly resultTool: string | undefined;
  /** The approval reached the client: a permission select frame arrived. */
  readonly surface: boolean;
  /** The learned contract: asked, answered, accepted, then the tool's result. A run with no ask is a
   *  hidden approval, however it was granted, and this stays false. */
  readonly approvedRun: boolean;
};

/**
 * Judges the received frames. `answers` is how many approval answers this client wrote and `accepted`
 * how many of those the host acknowledged with `success: true`.
 */
export function judgeApproval(frames: readonly Frame[], token: string, answers: number, accepted: number): ApprovalFacts {
  const asks: string[] = [];
  let firstAsk: number | undefined;
  let resultAt: number | undefined;
  let resultTool: string | undefined;
  frames.forEach((frame, index) => {
    if (
      frame.type === "extension_ui_request" &&
      frame.method === "select" &&
      typeof frame.title === "string" &&
      frame.title.startsWith(APPROVAL_TITLE)
    ) {
      asks.push(frame.title.split("\n", 1)[0] ?? frame.title);
      if (firstAsk === undefined) firstAsk = index;
    }
    const result = JSON.stringify(frame.type === "tool_execution_end" ? (frame.result ?? {}) : null);
    if (frame.type === "tool_execution_end" && result.includes(token) && resultAt === undefined) {
      resultAt = index;
      resultTool = typeof frame.toolName === "string" ? frame.toolName : "(unnamed)";
    }
  });
  const surface = asks.length > 0;
  return {
    asks: asks,
    firstAsk: firstAsk,
    resultAt: resultAt,
    resultTool: resultTool,
    surface: surface,
    approvedRun: surface && answers > 0 && accepted > 0 && resultAt !== undefined && firstAsk !== undefined && resultAt > firstAsk,
  };
}

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** The frame log without the streaming deltas: the records that decide the case stay readable. */
const BULK_FRAME_TYPES = new Set(["message_update", "partial", "tool_execution_update"]);

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const key = process.env.BRIDGE_QA_MODEL_KEY;
  if (key === undefined || key.length === 0) {
    record("model-key-supplied", "BRIDGE_QA_MODEL_KEY set", "not set", false);
    return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] } };
  }

  const token = "perm-" + randomBytes(12).toString("hex");
  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-perm-live-"));
  const container = "bridge-qa-perm-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    docker(["run", "-d", "--name", container, "-e", "OPENCODE_API_KEY=" + key, IMAGE, "sleep", "infinity"]);
    docker([
      "exec",
      container,
      "bash",
      "-lc",
      "mkdir -p /home/bridge/.omo/agent /work && printf '{\"defaultModel\":\"" +
        MODEL.provider +
        "/" +
        MODEL.modelId +
        "\"}' > /home/bridge/.omo/agent/settings.json && printf '%s' '" +
        token +
        "' > " +
        PROBE_FILE,
    ]);
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 70), started.indexOf("lifecycle") !== -1);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    const frames: Frame[] = [];
    gateway = await openSocketGateway({ socketPath: path.join(scratch, "bridge.sock"), container: container, containerSocket: CONTAINER_SOCKET });
    const transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => frames.push(frame as Frame),
    );
    /* Declare that this connection belongs to a person's client: the documented role for a client that can
       answer prompts. */
    const declared = await transport.request("set_client_info", { width: 120, capabilities: ["interactive_user"] });
    record(
      "client-declared-interactive-user",
      "the host accepts the declaration",
      JSON.stringify(declared).slice(0, 90),
      JSON.stringify(declared).indexOf(String.fromCharCode(34) + "success" + String.fromCharCode(34) + ":true") !== -1,
    );

    const opened = await transport.request("open_session", { cwd: "/work", permissionPreset: "ask" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    record("session-opened-under-the-ask-preset", "a session id", String(sessionId), sessionId !== undefined);
    const routing = sessionId ?? "";

    /* The host's own model profile can resolve the startup model to a lane this run has no entitlement
       for, so the case names the model the way the TUI's model picker does and reads back what the host
       selected. Without a working model there is no tool call, and without a tool call no approval. */
    const setModel = await transport.request("set_model", { sessionId: routing, provider: MODEL.provider, modelId: MODEL.modelId });
    const state = await transport.request("get_state", { sessionId: routing });
    const stateData = (typeof state.data === "object" && state.data !== null ? state.data : {}) as Record<string, unknown>;
    const model = (typeof stateData.model === "object" && stateData.model !== null ? stateData.model : {}) as Record<string, unknown>;
    const observedModel = String(model.provider) + "/" + String(model.id);
    record(
      "a-model-that-answers-is-selected",
      "set_model accepted and get_state names " + MODEL.provider + "/" + MODEL.modelId,
      "set_model=" + String(setModel.success) + " state=" + observedModel,
      setModel.success === true && model.provider === MODEL.provider && model.id === MODEL.modelId,
    );
    const preset = typeof stateData.permissionPreset === "string" ? stateData.permissionPreset : undefined;
    const presetStatus = typeof stateData.permissionPresetStatus === "string" ? stateData.permissionPresetStatus : undefined;
    const effective = typeof stateData.effectivePermissionPreset === "string" ? stateData.effectivePermissionPreset : undefined;
    record(
      "the-host-states-which-preset-it-enforces",
      "ask is the named, applied and effective preset",
      String(preset) + "/" + String(presetStatus) + "/" + String(effective),
      preset === "ask" && presetStatus === "applied" && effective === "ask",
    );

    await transport.request("prompt", {
      sessionId: routing,
      message: "Run this shell command with the bash tool and report its output exactly: cat " + PROBE_FILE,
      clientMessageId: "perm-live-1",
    });

    /* Answer every approval dialog the host raises, the way the TUI's dialog panel does: through the
       shipped encoder, naming the request and the routing session the dialog arrived on. A dialog is
       answered once, by its request id: the stream repeats the open frame while it waits. */
    const answeredRequests = new Set<string>();
    const answerIds = new Set<string>();
    let accepted = 0;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      for (const frame of frames) {
        if (frame.type !== "extension_ui_request" || frame.method !== "select") continue;
        if (typeof frame.title !== "string" || !frame.title.startsWith(APPROVAL_TITLE)) continue;
        const requestId = typeof frame.id === "string" ? frame.id : undefined;
        if (requestId === undefined || answeredRequests.has(requestId)) continue;
        answeredRequests.add(requestId);
        const answerId = "perm-answer-" + String(answeredRequests.size);
        answerIds.add(answerId);
        const encoded = encodeHostResponseFrame({
          id: answerId,
          uiRequestId: requestId,
          ...(typeof frame.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
          answer: { kind: "value", value: "Allow once" },
        });
        if (!encoded.ok) continue;
        transport.send(encoded.frame);
      }
      accepted = frames.filter(
        (frame) =>
          frame.type === "response" &&
          frame.command === "extension_ui_response" &&
          typeof frame.id === "string" &&
          answerIds.has(frame.id) &&
          frame.success === true,
      ).length;
      const ran = judgeApproval(frames, token, answeredRequests.size, accepted).resultAt !== undefined;
      if (ran) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const answers = answeredRequests.size;
    const facts = judgeApproval(frames, token, answers, accepted);
    const methods = new Set<string>();
    for (const frame of frames) {
      if (frame.type === "extension_ui_request" && typeof frame.method === "string") methods.add(frame.method);
    }
    record(
      "ui-requests-seen",
      "an extension_ui_request select titled '" + APPROVAL_TITLE + " <action>' reaches this client",
      facts.surface ? facts.asks.join(" | ") : "no approval select; ui request methods: " + [...methods].join(","),
      facts.surface,
    );
    record(
      "the-host-accepted-the-answer",
      "one host acknowledgement per answer, all successful",
      answers + " answer(s), " + accepted + " accepted",
      answers > 0 && accepted === answers,
    );
    record(
      "answered-approval-let-the-tool-run",
      "the approved tool's own result carries the token, after the dialog was answered",
      "ask@" + String(facts.firstAsk) + " result@" + String(facts.resultAt) + " tool=" + String(facts.resultTool) + " token=" + token,
      facts.approvedRun,
    );

    const kept = frames.filter((frame) => !BULK_FRAME_TYPES.has(String(frame.type)));
    const framesPath = path.join(context.out, "host-frames.json");
    writeFileSync(
      framesPath,
      JSON.stringify({ total: frames.length, kept: kept.length, droppedStreamingDeltas: frames.length - kept.length, frames: kept }, null, 1),
      { mode: 0o600 },
    );
    const answersPath = path.join(context.out, "answers.json");
    writeFileSync(
      answersPath,
      JSON.stringify(
        {
          token: token,
          answers: [...answerIds],
          hostReplies: frames.filter((frame) => frame.type === "response" && frame.command === "extension_ui_response"),
          verdict: facts,
        },
        null,
        1,
      ),
      { mode: 0o600 },
    );
    transport.close();
    return {
      checks: checks,
      cleanup: { ok: checks.every((check) => check.pass), detail: detail },
      artifacts: [path.basename(framesPath), path.basename(answersPath)],
    };
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
    return { checks: checks, cleanup: { ok: false, detail: detail } };
  } finally {
    if (gateway !== undefined) {
      detail.push("gateway closed with " + String(gateway.open()) + " forwarded connection(s)");
      await gateway.close();
    }
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    detail.push("staged key record and scratch socket removed");
  }
}
