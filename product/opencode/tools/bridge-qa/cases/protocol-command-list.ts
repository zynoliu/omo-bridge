import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";

/**
 * What the host says it accepts.
 *
 * The capability matrix carries dozens of session-protocol rows, and guessing command names to test them
 * would produce evidence about guessing, not about the host. This case records the host's own declaration
 * so rows can be classified against it, and states plainly that a declared command is a claim the bridge
 * has not yet exercised.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-protocol-list-"));
  const container = "bridge-qa-protocol-list-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 70), started.indexOf("lifecycle") !== -1);

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

    const info = (await transport.request("get_protocol_info", {})) as { success?: boolean; data?: unknown };
    const payload = JSON.stringify(info.data ?? null);
    writeFileSync(path.join(context.out, "protocol-info.json"), payload);
    record(
      "protocol-info-recorded",
      "the host's own declaration is written to protocol-info.json",
      String(payload.length) + " bytes",
      payload.length > 2,
    );

    const text = payload.toLowerCase();
    for (const [row, needle] of [
      ["P-608 session.update", "set_session_name"],
      ["P-610 session.fork", "fork"],
      ["P-611 session.switchAgent", "agent"],
      ["P-626 session.interrupt", "interrupt"],
    ] as const) {
      record(
        "declared-" + row.split(" ")[0],
        "the protocol declaration mentions " + needle,
        text.indexOf('"' + needle) !== -1 ? "mentioned" : "not mentioned",
        text.indexOf('"' + needle) !== -1,
      );
    }

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
