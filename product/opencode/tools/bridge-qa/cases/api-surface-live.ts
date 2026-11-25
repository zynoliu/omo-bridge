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
 * The adapter api against the real host: server.info and session.list.
 *
 * Both are ordinary reads a running TUI depends on and both had been exercised in unit tests only.
 * This case drives them over an authenticated connection to the isolated official host, so the
 * capability ledger can point at runtime evidence rather than a mock.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-api-live-"));
  const container = "bridge-qa-api-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    /* The host reads credentials from its auth.json, not from the environment, so the key is written
       into the agent directory before the daemon starts. */
    const key = modelKey();
    if (key === undefined) {
      record("provider-credential-supplied", "BRIDGE_QA_MODEL_KEY set", "not set, so the catalogue stays empty", false);
      return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] }, blocked: true };
    }
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    stageProviderCredential(container, key);
    const credential = credentialStatus(container);
    record(
      "provider-credential-is-ready",
      "the host reports the provider as ready",
      credential.slice(0, 100),
      credential.includes('"status":"ready"'),
    );
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 80), started.indexOf("lifecycle") !== -1);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({ socketPath: path.join(scratch, "bridge.sock"), container: container, containerSocket: CONTAINER_SOCKET });
    const transport = await openBridgeTransport({
      socket: gateway.socketPath,
      keyRecord: keyRecord,
      cwd: "/work",
      mini: false,
      handshakeTimeoutMs: 20_000,
    });
    record("transport-authenticated", "authenticated", transport.report.state, transport.report.state === "authenticated");

    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    record("host-holds-a-session", "a session id", String(sessionId), sessionId !== undefined);

    /* Pull what the host holds first: an empty store would make the list assertion meaningless. */
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    await pullHostState(transport, data, sessions);
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/work" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      /* The launcher performs the switch over its transport; the case supplies the same call so the api
         member is exercised the way the TUI exercises it. */
      switchModel: async (input) => {
        const answer = await transport.request("set_model", {
          sessionId: sessionId,
          provider: input.providerID,
          modelId: input.modelID,
        });
        if (answer.success !== true) throw new Error("set_model refused: " + JSON.stringify(answer).slice(0, 120));
        return answer.data;
      },
    });

    const info = (await api.server.info()) as { capabilities?: { persistentPty?: boolean } };
    record(
      "server-info-answers-at-runtime",
      "a capabilities object",
      JSON.stringify(info).slice(0, 90),
      typeof info === "object" && info !== null && typeof info.capabilities === "object",
    );

    const models = (data.location().model ?? []) as readonly { id?: string; providerID?: string }[];
    record(
      "model-catalogue-arrives-from-the-host",
      "at least one model",
      String(models.length) + " model(s)" + (models[0] === undefined ? "" : ": " + String(models[0].providerID) + "/" + String(models[0].id)),
      models.length > 0,
    );

    const first = models[0];
    const durable = (data.hostSessionList()[0] as { id?: string } | undefined)?.id;
    let switched: unknown;
    let switchFailed = "";
    if (first !== undefined && durable !== undefined) {
      try {
        switched = await api.session.switchModel({
          sessionID: durable,
          model: { providerID: String(first.providerID), id: String(first.id) },
        } as never);
      } catch (error) {
        switchFailed = String(error).slice(0, 120);
      }
    }
    record(
      "session-switch-model-reaches-the-host",
      "the host answers the switch",
      switchFailed.length > 0 ? switchFailed : JSON.stringify(switched ?? null).slice(0, 90),
      switchFailed.length === 0 && switched !== undefined,
    );

    const listed = (await api.session.list({})) as { data?: readonly unknown[] };
    record(
      "session-list-answers-at-runtime",
      "an array of sessions",
      Array.isArray(listed.data) ? String(listed.data.length) + " session(s): " + (listed.data ?? []).map((row) => String((row as { id?: string }).id)).join(",").slice(0, 40) : JSON.stringify(listed).slice(0, 80),
      /* The list reports durable session ids; open_session answered with the host's routing id for the
         same session, so the count is what this asserts, not an id equality across the two vocabularies. */
      Array.isArray(listed.data) && (listed.data ?? []).length > 0,
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
