import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";

const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[], options: { readonly input?: string } = {}): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: options.input,
  });
}

/** Waits for the host's socket to exist and answer, bounded by a deadline rather than a fixed sleep. */
async function waitForHost(container: string, deadlineMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = docker(["exec", container, "omo", "daemon", "status", "--json"]);
      const parsed = JSON.parse(status.trim().split("\n").pop() ?? "{}") as {
        endpoints?: readonly { readonly reachable?: boolean }[];
      };
      if ((parsed.endpoints ?? []).some((endpoint) => endpoint.reachable === true)) return true;
    } catch {
      /* the daemon may not be up yet; the deadline, not an error, decides the outcome */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** The key record has to sit at <agent>/rpc/keys/<id> with plain, owner-only directories. */
function stageKeyRecord(container: string, root: string): string {
  const keysDir = path.join(root, "agent", "rpc", "keys");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  for (const dir of [path.join(root, "agent"), path.join(root, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
  const listing = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n");
  const name = listing.filter((entry) => entry.length > 0)[0];
  if (name === undefined) throw new Error("the host wrote no key record");
  const target = path.join(keysDir, name);
  docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + name, target]);
  chmodSync(target, 0o600);
  return target;
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const cleanupDetail: string[] = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-docker-host-"));
  const container = "bridge-qa-host-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  const transports: BridgeTransport[] = [];
  let cleanupOk = true;

  const record = (name: string, expected: string, observed: string, pass: boolean) => {
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  };

  try {
    docker(["image", "inspect", IMAGE]);
    record("target-artifact-available", IMAGE + " present", IMAGE + " present", true);
  } catch (error) {
    record("target-artifact-available", IMAGE + " present", "missing: " + String(error).slice(0, 120), false);
    return { checks: checks, cleanup: { ok: true, detail: ["nothing was started"] } };
  }

  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record(
      "host-daemon-starts",
      "lifecycle ready",
      started.slice(0, 120),
      started.includes('"lifecycle":"ready"') || started.includes('"action":"start"'),
    );
    const reachable = await waitForHost(container);
    record("host-answers-status", "one reachable endpoint", String(reachable), reachable);

    const keyRecord = stageKeyRecord(container, scratch);
    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });
    record(
      "gateway-socket-is-owner-only",
      "0600",
      (statSync(gateway.socketPath).mode & 0o777).toString(8),
      (statSync(gateway.socketPath).mode & 0o777) === 0o600,
    );

    const options = { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 };
    const first = await openBridgeTransport(options);
    transports.push(first);
    record(
      "first-connection-authenticates",
      "authenticated",
      first.report.state + ":" + first.report.code,
      first.report.state === "authenticated",
    );

    const second = await openBridgeTransport(options);
    transports.push(second);
    record(
      "second-connection-authenticates",
      "authenticated",
      second.report.state + ":" + second.report.code,
      second.report.state === "authenticated",
    );

    const protocol = await first.request("get_protocol_info", {});
    record(
      "protocol-info-answers",
      "success true with capabilities",
      JSON.stringify(protocol).slice(0, 120),
      protocol.success === true && JSON.stringify(protocol).includes("capabilities"),
    );

    const subscribed = await first.request("subscribe_sessions", {});
    record(
      "subscribe-sessions-accepted",
      "success true",
      JSON.stringify(subscribed).slice(0, 120),
      subscribed.success === true,
    );

    /* The session listing needs no running session, so the second connection can prove it reads real
       host state rather than only the handshake. */
    const state = await second.request("list_sessions", {});
    record(
      "second-connection-reads-host-state",
      "success true",
      JSON.stringify(state).slice(0, 120),
      state.success === true,
    );

    first.close();
    const afterDrop = transports.indexOf(first);
    transports.splice(afterDrop, 1);
    const reconnected = await openBridgeTransport(options);
    transports.push(reconnected);
    record(
      "reconnect-after-drop-authenticates",
      "authenticated",
      reconnected.report.state + ":" + reconnected.report.code,
      reconnected.report.state === "authenticated",
    );
    const reopen = await reconnected.request("get_protocol_info", {});
    record("reconnected-host-still-answers", "success true", JSON.stringify(reopen).slice(0, 80), reopen.success === true);
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
    cleanupOk = false;
  } finally {
    for (const transport of transports) {
      try {
        transport.close();
      } catch {
        cleanupOk = false;
      }
    }
    if (gateway !== undefined) {
      const openBefore = gateway.open();
      await gateway.close();
      cleanupDetail.push("gateway closed with " + String(openBefore) + " forwarded connection(s) at that moment");
    }
    try {
      docker(["rm", "-f", container]);
      cleanupDetail.push("container " + container + " removed");
    } catch {
      cleanupOk = false;
      cleanupDetail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    cleanupDetail.push("key record copy and scratch socket removed");
  }

  return {
    checks: checks,
    cleanup: { ok: cleanupOk && checks.every((check) => check.pass), detail: cleanupDetail },
  };
}
