import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";

export const HOST_IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

export type LiveHostBlocked = { readonly kind: "blocked"; readonly reason: string };

export type LiveHost = {
  readonly kind: "open";
  readonly container: string;
  readonly transport: BridgeTransport;
  readonly data: BridgeData;
  /** One correlated command; a transport failure is returned as data so a case can record it. */
  readonly ask: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly close: () => Promise<readonly string[]>;
};

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForHost(container: string, deadlineMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = docker(["exec", container, "omo", "daemon", "status", "--json"]);
      const parsed = JSON.parse(status.trim().split("\n").pop() ?? "{}") as {
        endpoints?: readonly { readonly reachable?: boolean }[];
      };
      if ((parsed.endpoints ?? []).some((endpoint) => endpoint.reachable === true)) return true;
    } catch {
      /* the deadline, not the error, decides whether the host came up */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export type LiveHostOptions = {
  /**
   * Runs after `docker run` and before `omo daemon run`, with a docker argv runner scoped to the new
   * container. That is the one window where a case can put the profile the daemon reads at start
   * (`<agentDir>/settings.json`, a launch spec) inside the container; nothing here writes the worktree.
   */
  readonly prepare?: (container: string, run: (args: readonly string[]) => string) => void;
};

/**
 * One isolated official host behind the bridge's own authenticated transport. A run that supplies
 * `BRIDGE_QA_MODEL_KEY` hands it to the container as the provider credential, so a case can select a
 * real model; no case built on this helper may consume a model turn.
 */
export async function openLiveHost(
  scratchPrefix: string,
  onFrame?: (frame: unknown) => void,
  options: LiveHostOptions = {},
): Promise<LiveHostBlocked | LiveHost> {
  try {
    docker(["image", "inspect", HOST_IMAGE]);
  } catch {
    return { kind: "blocked", reason: HOST_IMAGE + " is not built on this machine" };
  }
  const scratch = mkdtempSync(path.join(tmpdir(), scratchPrefix));
  const container = "bridge-qa-" + scratchPrefix.replace(/[^a-z0-9]/g, "") + String(Date.now());
  let gateway: SocketGateway | undefined;
  let transport: BridgeTransport | undefined;
  const detail: string[] = [];
  const fail = async (reason: string): Promise<LiveHostBlocked> => {
    try {
      transport?.close();
    } catch {
      /* nothing was open */
    }
    if (gateway !== undefined) {
      await gateway.close().catch(() => undefined);
    }
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    detail.push("staged key record and scratch socket removed");
    return { kind: "blocked", reason: reason + " (" + detail.join("; ") + ")" };
  };

  try {
    const modelKey = process.env.BRIDGE_QA_MODEL_KEY;
    const providerEnv = modelKey === undefined || modelKey.length === 0 ? [] : ["-e", "OPENCODE_API_KEY=" + modelKey];
    docker(["run", "-d", "--name", container, ...providerEnv, HOST_IMAGE, "sleep", "infinity"]);
    options.prepare?.(container, (args) => docker(args));
    docker(["exec", container, "omo", "daemon", "run", "--json"]);
    if (!(await waitForHost(container))) return await fail("the host daemon never became reachable");

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    if (name === undefined || name.length === 0) return await fail("the host wrote no key record");
    const keyRecord = path.join(keysDir, name);
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + name, keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });
    const data = new BridgeData();
    transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => {
        onFrame?.(frame);
        data.publishEvent(frame);
      },
    );
    if (transport.report.state !== "authenticated") {
      return await fail("the transport reached " + transport.report.state + ", not authenticated");
    }
    const opened = transport;
    const openedGateway = gateway;
    return {
      kind: "open",
      container: container,
      transport: opened,
      data: data,
      ask: async (type, payload = {}) => {
        try {
          return (await opened.request(type, payload)) as Record<string, unknown>;
        } catch (error) {
          return { thrown: String(error).slice(0, 200) };
        }
      },
      close: async () => {
        try {
          opened.close();
        } catch {
          detail.push("the transport was already closed");
        }
        await openedGateway.close();
        detail.push("gateway closed with " + String(openedGateway.open()) + " forwarded connection(s) at that moment");
        try {
          docker(["rm", "-f", container]);
          detail.push("container " + container + " removed");
        } catch {
          detail.push("container " + container + " could not be removed");
        }
        rmSync(scratch, { recursive: true, force: true });
        detail.push("staged key record and scratch socket removed");
        return detail;
      },
    };
  } catch (error) {
    return await fail(String(error).slice(0, 200));
  }
}

export function text(value: unknown, max = 240): string {
  return JSON.stringify(value ?? null).slice(0, max);
}

export function dataOf(answer: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = answer.data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
}
