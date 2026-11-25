import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";
import { createEventSurface, createPartSurface, createSessionSurface } from "../../../packages/bridge-core/src/index.ts";
import { credentialStatus, modelKey, stageProviderCredential } from "./model-credential.ts";

const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** Task 26's success scenario: switch a session's model on the isolated host and read the host's confirmation. */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const key = modelKey();
  if (key === undefined) {
    record("provider-credential-supplied", "BRIDGE_QA_MODEL_KEY set", "not set, so no model can be selected", false);
    return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] }, blocked: true };
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-config-model-"));
  const container = "bridge-qa-config-" + String(Date.now());
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
    docker(["exec", container, "omo", "daemon", "run", "--json"]);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });
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

    const data = new BridgeData();
    await pullHostState(transport, data);
    const models = (data.location().model ?? []) as readonly { id?: string; providerID?: string }[];
    record(
      "catalogue-offers-more-than-one-model",
      "at least two models, so a switch has a target",
      String(models.length) + " model(s)",
      models.length >= 2,
    );

    const target = models[1];
    const durable = (data.hostSessionList()[0] as { id?: string } | undefined)?.id;
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/work" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
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

    let switched: unknown;
    let failure = "";
    if (target !== undefined && durable !== undefined) {
      try {
        switched = await api.session.switchModel({
          sessionID: durable,
          model: { providerID: String(target.providerID), id: String(target.id) },
        } as never);
      } catch (error) {
        failure = String(error).slice(0, 120);
      }
    }
    record(
      "switch-is-answered-by-the-host",
      "the host answers the switch",
      failure.length > 0 ? failure : JSON.stringify(switched ?? null).slice(0, 100),
      failure.length === 0 && switched !== undefined,
    );

    /* The switch has to be the host's state, not the bridge's hope: the host is asked again afterwards. */
    const stateAfter = await transport.request("get_state", { sessionId: sessionId });
    const stateText = JSON.stringify(stateAfter);
    const selected = target === undefined ? "" : String(target.providerID) + "/" + String(target.id);
    record(
      "host-state-reports-the-selected-model",
      "the host's own state names the model that was selected",
      stateAfter.success === true ? stateText.slice(0, 160) : "get_state refused",
      stateAfter.success === true && selected.length > 0 && stateText.includes(String(target?.id ?? "")),
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    if (gateway !== undefined) await gateway.close();
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
