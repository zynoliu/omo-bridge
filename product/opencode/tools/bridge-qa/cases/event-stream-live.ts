import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { createEventSurface } from "../../../packages/bridge-core/src/event-surface.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";
import { createSessionSurface } from "../../../packages/bridge-core/src/opencode-surface.ts";
import { createPartSurface } from "../../../packages/bridge-core/src/part-surface.ts";

/**
 * The product's client event stream against the real host: it must carry the handshake, then at
 * least one event projected from a host frame, without any model turn or provider credential.
 *
 * The session is opened through the launcher's own transport (the product surface that exists for
 * creating one), and every inbound frame is published into `BridgeData` exactly as the launcher does,
 * so the projector and the stream are the shipping ones rather than a fixture.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

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
      /* the daemon may not be up yet; the deadline, not the error, decides the outcome */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

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

type Frame = { readonly [key: string]: unknown };

/** One iterator step, bounded by a deadline instead of a sleep. */
async function nextWithin(
  iterator: AsyncIterator<Frame>,
  ms: number,
): Promise<{ readonly done: true } | { readonly done: false; readonly value: Frame } | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const raced = await Promise.race([iterator.next(), deadline]);
    return raced === "timeout" ? "timeout" : raced.done === true ? { done: true } : { done: false, value: raced.value as Frame };
  } finally {
    clearTimeout(timer);
  }
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const cleanupDetail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) => {
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  };

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-event-stream-"));
  const container = "bridge-qa-events-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  const transports: BridgeTransport[] = [];
  let cleanupOk = true;

  try {
    docker(["image", "inspect", IMAGE]);
  } catch {
    record("host-image-available", IMAGE + " present", IMAGE + " is not built on this machine", false);
    rmSync(scratch, { recursive: true, force: true });
    return {
      checks: checks,
      cleanup: { ok: true, detail: ["nothing was started; the host image is the missing precondition"] },
      blocked: true,
    };
  }

  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    docker(["exec", container, "omo", "daemon", "run", "--json"]);
    const reachable = await waitForHost(container);
    if (!reachable) {
      record("host-daemon-reachable", "one reachable endpoint", "the daemon never answered", false);
      return {
        checks: checks,
        cleanup: { ok: true, detail: ["the host daemon never became reachable; the stream could not be exercised"] },
        blocked: true,
      };
    }
    record("host-daemon-reachable", "one reachable endpoint", "reachable", true);

    const keyRecord = stageKeyRecord(container, scratch);
    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });

    const data = new BridgeData();
    const transport = await openBridgeTransport(
      { socket: gateway.socketPath, keyRecord: keyRecord, cwd: "/work", mini: false, handshakeTimeoutMs: 20_000 },
      (frame) => data.publishEvent(frame),
    );
    transports.push(transport);

    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/work" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const controller = new AbortController();
    const iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]() as AsyncIterator<Frame>;

    const connected = await nextWithin(iterator, 20_000);
    const firstType = connected === "timeout" || connected.done ? "no event" : String(connected.value.type);
    record("stream-first-event-is-server-connected", "server.connected", firstType, firstType === "server.connected");

    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    record(
      "open-session-accepted",
      "the host opens a session",
      opened.success === true ? "sessionId " + String(sessionId) : JSON.stringify(opened).slice(0, 160),
      opened.success === true,
    );

    const collected: { readonly id: string; readonly type: string }[] = [];
    const firstHostEvent = await nextWithin(iterator, 20_000);
    if (firstHostEvent !== "timeout" && !firstHostEvent.done)
      collected.push({ id: String(firstHostEvent.value.id), type: String(firstHostEvent.value.type) });
    /* On this host an open projects a single lifecycle event, so a second open is what makes the
       stream carry a second one; a model turn would be the alternative and is out of scope here. */
    await transport.request("open_session", { cwd: "/work" });
    while (collected.length < 5) {
      const next = await nextWithin(iterator, 5_000);
      if (next === "timeout" || next.done) break;
      collected.push({ id: String(next.value.id), type: String(next.value.type) });
    }
    record(
      "stream-carries-host-derived-events",
      "at least one projected host event after server.connected",
      collected.length === 0 ? "none within the deadline" : collected.map((event) => event.type).join(", "),
      collected.length > 0,
    );

    /* The projector numbers events in the order it emits them, so the ids a subscriber observes must
       rise strictly; a single inverted pair is the defect this check exists for. */
    const ordinals = collected.map((event) => Number(event.id.replace("bridge-", "")));
    const ascending = ordinals.every(
      (ordinal, index) => Number.isFinite(ordinal) && (index === 0 || ordinal > (ordinals[index - 1] ?? Number.NaN)),
    );
    record(
      "stream-event-ids-ascend",
      "strictly ascending ids across the first five projected events",
      collected.length === 0 ? "no projected event to compare" : collected.map((event) => event.id + " " + event.type).join(", "),
      collected.length >= 2 && ascending,
    );

    controller.abort();
    await iterator.next().catch(() => undefined);
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

  return { checks: checks, cleanup: { ok: cleanupOk && checks.every((check) => check.pass), detail: cleanupDetail } };
}
