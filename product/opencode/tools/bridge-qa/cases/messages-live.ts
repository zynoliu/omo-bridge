import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import { credentialStatus, modelKey, stageProviderCredential } from "./model-credential.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createEventSurface } from "../../../packages/bridge-core/src/event-surface.ts";
import { createSessionSurface } from "../../../packages/bridge-core/src/opencode-surface.ts";
import { createPartSurface } from "../../../packages/bridge-core/src/part-surface.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";

/**
 * Message history against the real host: the list, one message by id, and its parts.
 *
 * A real turn is run first, so the transcript being read is one the host actually produced rather than
 * a fixture. The case then reads it back through the adapter surface a TUI uses.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";
const PROVIDER = "opencode-go";
const MODEL = "deepseek-v4.1-flash";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const key = modelKey();
  if (key === undefined) {
    record("provider-credential-supplied", "BRIDGE_QA_MODEL_KEY set", "not set, so no real turn can run", false);
    return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] }, blocked: true };
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-messages-"));
  const container = "bridge-qa-msg-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    stageProviderCredential(container, key);
    const credential = credentialStatus(container);
    record(
      "provider-credential-is-ready",
      "the host reports the provider as ready",
      credential.slice(0, 100),
      credential.includes('"status":"ready"'),
    );
    docker(["exec", container, "bash", "-lc", "mkdir -p /home/bridge/.omo/agent && printf '{\"defaultModel\":\"opencode-go/deepseek-v4.1-flash\"}' > /home/bridge/.omo/agent/settings.json"]);
    docker(["exec", container, "omo", "daemon", "run", "--json"]);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({ socketPath: path.join(scratch, "bridge.sock"), container: container, containerSocket: CONTAINER_SOCKET });
    const events: string[] = [];
    const transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => events.push(JSON.stringify(frame)),
    );
    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    await transport.request("set_model", { sessionId: sessionId, provider: PROVIDER, modelId: MODEL });
    await transport.request("prompt", { sessionId: sessionId, message: "Do not use any tools. Reply with exactly: OK", clientMessageId: "msg-case-1" });

    const deadline = Date.now() + 120_000;
    let finished = false;
    while (Date.now() < deadline && !finished) {
      finished = events.some((line) => line.indexOf('"stopReason":"stop"') !== -1);
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    record("a-real-turn-produced-a-transcript", "an assistant message with stopReason stop", finished ? "stop" : "not observed", finished);

    const data = new BridgeData();
    const sessions = new SessionRegistry();
    await pullHostState(transport, data, sessions);
    const durable = data.hostSessionList()[0]?.id;
    const viewSession = data.view().sessions[0]?.id;
    const messages = durable === undefined ? [] : data.hostMessagesFor(durable);
    record("message-list-reports-the-transcript", "at least a prompt and a reply", String(messages.length) + " message(s)", messages.length >= 2);

    /* A real turn must show up in the host's own accounting; zeros here would mean the row is unmeasured. */
    const session = data.hostSessionList()[0];
    const tokens = session?.tokens;
    record(
      "host-reports-token-usage",
      "the pulled session carries non-zero input tokens",
      String(tokens?.input ?? "absent") + " input / " + String(tokens?.output ?? "absent") + " output, cost " + String(session?.cost ?? "absent"),
      (tokens?.input ?? 0) > 0,
    );

    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/work" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const first = messages[0];
    /* The api returns the message itself; parts come from the part surface the TUI renders with. */
    const got = first === undefined || durable === undefined ? undefined : (await api.session.message.get({ sessionID: durable, messageID: first.id })) as { id?: string };
    record("one-message-by-id-answers", "the message with the id asked for", String(got?.id), got?.id === first?.id);

    const assistant = messages.find((message) => message.type !== "user");
    /* The part surface projects the view's selected session, so the session under test is selected. */
    if (viewSession !== undefined) data.select(viewSession);
    const partSurface = createPartSurface(data);
    const kinds = new Set<string>();
    for (const message of messages) {
      if (viewSession === undefined) break;
      const listed = await partSurface.part.list({ sessionID: viewSession, messageID: message.id });
      for (const part of listed) kinds.add(String(part.type));
    }
    const partKinds = [...kinds];
    /* The row this proves needs all three shapes: text, reasoning and tool parts, each read back from the
       transcript the host delivered rather than from a live buffer. */
    record(
      "part-surface-answers-for-the-selected-session",
      "text, reasoning and tool parts come back from the transcript",
      partKinds.join(",") + " (" + String(assistant === undefined ? 0 : messages.length) + " message(s) read)",
      partKinds.includes("text") && partKinds.includes("reasoning") && partKinds.includes("tool"),
    );

    transport.close();
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
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

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
