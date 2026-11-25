import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";

/**
 * An isolated official host that can run a real model turn.
 *
 * `live-host.ts` forwards the key as a provider environment variable, which the host never reads; a
 * turn needs the credential in `<agentDir>/auth.json`, written inside the container over stdin before
 * the daemon starts. The key travels only on that stdin pipe: it is never in a docker argument, a
 * shape printed here, or an evidence file.
 */

export const MODEL_HOST_IMAGE = "bridge-host-official:5.1.75";
export const MODEL_HOST_PROVIDER = "opencode-go";
export const MODEL_HOST_MODEL = "deepseek-v4.1-flash";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";
const TURN_TIMEOUT_MS = 240_000;

export type Frame = Record<string, unknown>;

export type ModelHostBlocked = { readonly kind: "blocked"; readonly reason: string };

export type ModelHost = {
  readonly kind: "open";
  readonly container: string;
  readonly transport: BridgeTransport;
  /** Every non-correlated frame the host wrote, in arrival order, with a wait bound by the deadline. */
  readonly frames: FrameLog;
  readonly exec: (command: string) => string;
  /** Resolves once the frame matching `predicate` arrives; `undefined` when the deadline passed. */
  readonly waitFor: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame | undefined>;
  /** The next frame after this call; the caller loops on it instead of polling. */
  readonly next: (timeoutMs?: number) => Promise<Frame | undefined>;
  readonly waitForTurn: (clientMessageId: string) => Promise<Frame | undefined>;
  readonly close: () => Promise<readonly string[]>;
};

/**
 * Event-driven frame log: a waiter resolves on the frame itself, and the deadline only bounds how long
 * a missing frame is waited for, so nothing here paces the host with a sleep.
 */
export class FrameLog {
  private readonly seen: Frame[] = [];
  private readonly waiters = new Set<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }>();

  push(frame: Frame): void {
    this.seen.push(frame);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(frame)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    }
  }

  list(): readonly Frame[] {
    return this.seen;
  }

  find(predicate: (frame: Frame) => boolean): Frame | undefined {
    return this.seen.find(predicate);
  }

  filter(predicate: (frame: Frame) => boolean): Frame[] {
    return this.seen.filter(predicate);
  }

  waitFor(predicate: (frame: Frame) => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<Frame | undefined> {
    const existing = this.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const entry = {
        predicate: predicate,
        resolve: (frame: Frame) => {
          clearTimeout(timer);
          this.waiters.delete(entry);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.add(entry);
    });
  }

  /** The next frame written after this call, or `undefined` at the deadline: the loop never sleeps. */
  next(timeoutMs = TURN_TIMEOUT_MS): Promise<Frame | undefined> {
    return new Promise((resolve) => {
      const entry = {
        predicate: () => true,
        resolve: (frame: Frame) => {
          clearTimeout(timer);
          this.waiters.delete(entry);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.add(entry);
    });
  }
}

function docker(args: readonly string[], input?: string): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input: input }),
  });
}

function stageProviderCredential(container: string, key: string): void {
  execute(container, "umask 077; mkdir -p /home/bridge/.omo/agent; cat > /home/bridge/.omo/agent/auth.json", JSON.stringify({
    [MODEL_HOST_PROVIDER]: { type: "api_key", key: key },
  }));
}

function execute(container: string, command: string, input?: string): string {
  return execFileSync("docker", ["exec", "-i", container, "sh", "-c", command], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input: input }),
  });
}

async function waitForDaemon(container: string, deadlineMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = docker(["exec", container, "omo", "daemon", "status", "--json"]);
      const parsed = JSON.parse(status.trim().split("\n").pop() ?? "{}") as {
        endpoints?: readonly { readonly reachable?: boolean }[];
      };
      if ((parsed.endpoints ?? []).some((endpoint) => endpoint.reachable === true)) return true;
    } catch {
      // the deadline decides, not the error: the daemon is expected to be unreachable until ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function openModelHost(prefix: string, onFrame?: (frame: Frame) => void): Promise<ModelHostBlocked | ModelHost> {
  const key = process.env.BRIDGE_QA_MODEL_KEY;
  if (key === undefined || key.length === 0) {
    return { kind: "blocked", reason: "BRIDGE_QA_MODEL_KEY is not set, so no model turn can run" };
  }
  try {
    docker(["image", "inspect", MODEL_HOST_IMAGE]);
  } catch {
    return { kind: "blocked", reason: MODEL_HOST_IMAGE + " is not built on this machine" };
  }
  const scratch = mkdtempSync(path.join(tmpdir(), prefix));
  const container = "bridge-qa-" + prefix.replace(/[^a-z0-9]/g, "") + String(Date.now());
  const frames = new FrameLog();
  const detail: string[] = [];
  let gateway: SocketGateway | undefined;
  let transport: BridgeTransport | undefined;
  try {
    docker(["run", "-d", "--name", container, MODEL_HOST_IMAGE, "sleep", "infinity"]);
    stageProviderCredential(container, key);
    execute(container, "mkdir -p /work");
    docker(["exec", container, "omo", "daemon", "run", "--json"]);
    if (!(await waitForDaemon(container))) {
      throw new Error("the host daemon never became reachable");
    }
    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) {
      chmodSync(dir, 0o700);
    }
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    if (name === undefined || name.length === 0) throw new Error("the host wrote no key record");
    const keyRecord = path.join(keysDir, name);
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + name, keyRecord]);
    chmodSync(keyRecord, 0o600);
    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });
    transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => {
        frames.push(frame as Frame);
        onFrame?.(frame as Frame);
      },
    );
    if (transport.report.state !== "authenticated") throw new Error("transport " + transport.report.state);
    const opened = transport;
    return {
      kind: "open",
      container: container,
      transport: opened,
      frames: frames,
      exec: (command: string) => execute(container, command),
      waitFor: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => frames.waitFor(predicate, timeoutMs),
      next: (timeoutMs?: number) => frames.next(timeoutMs),
      waitForTurn: (clientMessageId: string) =>
        frames.waitFor(
          (frame) =>
            frame.type === "message_end" &&
            isRecord(frame.message) &&
            frame.message.role === "assistant" &&
            typeof frame.message.stopReason === "string" &&
            frame.clientMessageId === clientMessageId,
        ),
      close: async () => {
        try {
          opened.close();
        } catch {
          detail.push("transport was already closed");
        }
        if (gateway !== undefined) detail.push("gateway closed with " + String(gateway.open()) + " forwarded connection(s)");
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
    try {
      transport?.close();
    } catch {
      detail.push("transport was never open");
    }
    await gateway?.close().catch(() => undefined);
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed after the failure");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    return { kind: "blocked", reason: String(error).slice(0, 300) + " (" + detail.join("; ") + ")" };
  }
}

export function isRecord(value: unknown): value is Frame {
  if (typeof value !== "object" || value === null) return false;
  return !Array.isArray(value);
}

/** One assistant message's text, which is what a case reads to see what the model answered. */
export function assistantText(frame: Frame | undefined): string {
  const message = isRecord(frame) ? frame.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

/** The text of a tool result, whether it arrived as a frame result or inside a message block. */
export function toolResultText(frame: Frame): string {
  if (frame.type === "tool_execution_end") return JSON.stringify(frame.result ?? "");
  if (frame.type === "message_end" && isRecord(frame.message) && frame.message.role === "toolResult") {
    return JSON.stringify(frame.message.content ?? "");
  }
  return "";
}

export function permissionAskFrames(frames: readonly Frame[]): Frame[] {
  return frames.filter(
    (frame) =>
      frame.type === "extension_ui_request" &&
      frame.method === "select" &&
      typeof frame.title === "string" &&
      frame.title.startsWith("Permission required:"),
  );
}
