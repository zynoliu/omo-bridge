import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";

const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";
/* The model that this deployment's key may actually use; a model outside its allow-list answers 403. */
const PROVIDER = "opencode-go";
const MODEL = "deepseek-v4.1-flash";

function docker(args: readonly string[], env?: Readonly<Record<string, string>>): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
}

/**
 * The host stores provider credentials in its agent directory's auth.json; it reads no provider
 * environment variable, so the key is written there before the daemon starts. The document goes in on
 * stdin so the key never appears in a process argument.
 */
function stageProviderCredential(container: string, provider: string, key: string): void {
  execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", "umask 077; mkdir -p /home/bridge/.omo/agent; cat > /home/bridge/.omo/agent/auth.json"],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: JSON.stringify({ [provider]: { type: "api_key", key: key } }),
    },
  );
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const key = process.env.BRIDGE_QA_MODEL_KEY;
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  if (key === undefined || key.length === 0) {
    record("model-key-supplied", "BRIDGE_QA_MODEL_KEY set", "not set, so no model call can be made", false);
    return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] } };
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-model-turn-"));
  const container = "bridge-qa-model-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  let transport: BridgeTransport | undefined;
  const events: string[] = [];

  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    stageProviderCredential(container, PROVIDER, key);
    const credential = docker(["exec", container, "omo", "auth", "check", "--provider", PROVIDER, "--json"]);
    record(
      "provider-credential-is-ready",
      "the host reports the provider as ready",
      credential.trim().slice(0, 120),
      credential.includes('"status":"ready"'),
    );
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 100), started.includes('"lifecycle":"ready"'));

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);
    record("key-record-staged", "0600 inside a 0700 keys directory", String(statSync(keyRecord).mode & 0o777), (statSync(keyRecord).mode & 0o777) === 0o600);

    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });
    transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => events.push(JSON.stringify(frame)),
    );
    record("transport-authenticated", "authenticated", transport.report.state, transport.report.state === "authenticated");

    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    record("session-opened", "a session id", String(sessionId), sessionId !== undefined);

    const model = await transport.request("set_model", { sessionId: sessionId, provider: PROVIDER, modelId: MODEL });
    record(
      "model-selected",
      PROVIDER + "/" + MODEL,
      JSON.stringify(model).slice(0, 110),
      model.success === true,
    );

    const answer = await transport.request("prompt", {
      sessionId: sessionId,
      message: "Do not use any tools. Reply with exactly: OK",
      clientMessageId: "qa-client-msg-1",
    });
    const admission = JSON.stringify(answer);
    record(
      "prompt-admitted-with-our-id",
      "the host echoes qa-client-msg-1",
      admission.slice(0, 140),
      answer.success === true && admission.includes("qa-client-msg-1"),
    );

    const deadline = Date.now() + 180_000;
    let assistant: { stopReason?: string; model?: string; provider?: string; content?: readonly { type?: string; text?: string }[] } | undefined;
    while (Date.now() < deadline) {
      const parsed = events.map((line) => JSON.parse(line) as { type?: string; message?: typeof assistant });
      const ends = parsed.filter((frame) => frame.type === "message_end" && frame.message !== undefined);
      const withStop = ends.filter((frame) => frame.message?.stopReason === "stop");
      if (withStop.length > 0) {
        assistant = withStop[withStop.length - 1]?.message;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const text = (assistant?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    record("assistant-text-arrived", "a completed assistant message", String(assistant?.stopReason), assistant !== undefined);
    record("assistant-used-the-selected-model", PROVIDER + "/" + MODEL, String(assistant?.provider) + "/" + String(assistant?.model), assistant?.provider === PROVIDER && assistant?.model === MODEL);
    record("assistant-answered", "OK", text.slice(0, 40), text.trim().includes("OK"));

    const deltas = events.filter((line) => line.includes('"type":"message_update"') && line.includes("delta")).length;
    record("streaming-deltas-arrived", "more than one delta", String(deltas), deltas > 1);
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    try {
      transport?.close();
    } catch {
      /* closing twice is not a failure of the case */
    }
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
