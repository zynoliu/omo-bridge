import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, type BridgeEvent, type EventBus, type EventSubscription } from "../../src/http/events";
import {
  DEFAULT_SHELL_OUTPUT_LIMIT,
  handleSessionShell,
  handleShellGet,
  handleShellList,
  handleShellOutput,
  handleShellRemove,
  resetShells,
  setShellEventBus,
  setShellTransport,
  type ShellBashResult,
  type ShellInfo,
  type ShellOutput,
  type ShellTransport,
} from "../../src/http/handlers/shell";

const SESSION_ONE = "ses_one";

class FakeShellTransport implements ShellTransport {
  readonly commands: string[] = [];
  result: ShellBashResult = { output: "", exitCode: 0 };
  failure: Error | undefined;

  async bash(command: string): Promise<ShellBashResult> {
    this.commands.push(command);
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

class LocalBashTransport implements ShellTransport {
  async bash(command: string): Promise<ShellBashResult> {
    const result = Bun.spawnSync(["bash", "-c", command]);
    return {
      output: result.stdout.toString() + result.stderr.toString(),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
    };
  }
}

class NoBashTransport implements ShellTransport {}

function urlOf(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`http://bridge.test${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function postShell(sessionID: string, body: unknown, params: Record<string, string> = {}): Promise<Response> {
  const request = new Request(urlOf(`/api/session/${sessionID}/shell`, params), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return handleSessionShell(request, urlOf(`/api/session/${sessionID}/shell`, params));
}

function getShell(id: string, params: Record<string, string> = {}): Promise<Response> {
  return handleShellGet(new Request(urlOf(`/api/shell/${id}`, params)), urlOf(`/api/shell/${id}`, params));
}

function getOutput(id: string, params: Record<string, string> = {}): Promise<Response> {
  const path = `/api/shell/${id}/output`;
  return handleShellOutput(new Request(urlOf(path, params)), urlOf(path, params));
}

function listShells(params: Record<string, string> = {}): Promise<Response> {
  return handleShellList(new Request(urlOf("/api/shell", params)), urlOf("/api/shell", params));
}

function removeShell(id: string, params: Record<string, string> = {}): Promise<Response> {
  const path = `/api/shell/${id}`;
  return handleShellRemove(new Request(urlOf(path, params), { method: "DELETE" }), urlOf(path, params));
}

async function listData(): Promise<ShellInfo[]> {
  const response = await listShells();
  const body = (await response.json()) as { data: ShellInfo[] };
  return body.data;
}

async function runShell(command: string, result: ShellBashResult): Promise<string> {
  const transport = new FakeShellTransport();
  transport.result = result;
  setShellTransport(transport);
  const response = await postShell(SESSION_ONE, { command });
  expect(response.status).toBe(204);
  const shells = await listData();
  expect(shells.length).toBe(1);
  return shells[0]!.id;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readEvents(subscription: EventSubscription, count: number): Promise<BridgeEvent[]> {
  const reader = subscription.stream.getReader();
  const events: BridgeEvent[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await withTimeout(reader.read(), 1000, `timed out waiting for event ${index + 1}`);
      if (result.done || result.value === undefined) throw new Error(`event stream closed after ${index} events`);
      events.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

function shellEventBus(): EventBus {
  const bus = createEventBus({ capacity: 32 });
  setShellEventBus(bus);
  return bus;
}

beforeEach(() => {
  resetShells();
  setShellTransport(undefined);
  setShellEventBus(undefined);
});

afterEach(() => {
  resetShells();
  setShellTransport(undefined);
  setShellEventBus(undefined);
});

describe("session.shell", () => {
  test("echo hi runs through bash and its output is retained", async () => {
    setShellTransport(new LocalBashTransport());
    const response = await postShell(SESSION_ONE, { command: "echo hi" });
    expect(response.status).toBe(204);

    const shells = await listData();
    expect(shells.length).toBe(1);
    const shell = shells[0]!;
    expect(shell.command).toBe("echo hi");
    expect(shell.status).toBe("exited");
    expect(shell.exit).toBe(0);
    expect(shell.metadata.sessionID).toBe(SESSION_ONE);

    const outputResponse = await getOutput(shell.id);
    expect(outputResponse.status).toBe(200);
    const body = (await outputResponse.json()) as { data: ShellOutput };
    expect(body.data.output).toContain("hi");
    expect(body.data.cursor).toBe(body.data.size);
  });

  test("publishes started before ended with the running row and merged output", async () => {
    const bus = shellEventBus();
    const subscription = bus.subscribe({ types: ["session.shell.started", "session.shell.ended"] });
    const transport = new FakeShellTransport();
    transport.result = { output: "hi\n", exitCode: 0 };
    setShellTransport(transport);

    const response = await postShell(SESSION_ONE, { command: "echo hi" });
    expect(response.status).toBe(204);

    const events = await readEvents(subscription, 2);
    subscription.close();
    expect(events.map((event) => event.type)).toEqual(["session.shell.started", "session.shell.ended"]);

    const started = events[0]!.data as { sessionID: string; shell: ShellInfo };
    expect(started.sessionID).toBe(SESSION_ONE);
    expect(started.shell.status).toBe("running");
    expect(started.shell.command).toBe("echo hi");
    expect(started.shell.time.completed).toBeUndefined();

    const ended = events[1]!.data as { sessionID: string; shell: ShellInfo; output: ShellOutput };
    expect(ended.sessionID).toBe(SESSION_ONE);
    expect(ended.shell.id).toBe(started.shell.id);
    expect(ended.shell.status).toBe("exited");
    expect(ended.shell.exit).toBe(0);
    expect(ended.shell.time.completed).toBeNumber();
    expect(ended.output.output).toBe("hi\n");
    expect(ended.output.cursor).toBe(ended.output.size);
  });

  test("a failed bash call still settles the record and publishes ended", async () => {
    const bus = shellEventBus();
    const subscription = bus.subscribe({ types: ["session.shell.started", "session.shell.ended"] });
    const transport = new FakeShellTransport();
    transport.failure = new Error("bash exploded");
    setShellTransport(transport);

    const response = await postShell(SESSION_ONE, { command: "echo hi" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { _tag: string };
    expect(body._tag).toBe("ServiceUnavailableError");

    const events = await readEvents(subscription, 2);
    subscription.close();
    expect(events.map((event) => event.type)).toEqual(["session.shell.started", "session.shell.ended"]);
    const shells = await listData();
    expect(shells[0]!.status).toBe("exited");
  });

  test("answers 503 when no transport is wired", async () => {
    const response = await postShell(SESSION_ONE, { command: "echo hi" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { _tag: string; message: string };
    expect(body._tag).toBe("ServiceUnavailableError");
    expect(await listData()).toEqual([]);
  });

  test("answers 503 when the transport has no bash command", async () => {
    setShellTransport(new NoBashTransport());
    const response = await postShell(SESSION_ONE, { command: "echo hi" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { _tag: string })._tag).toBe("ServiceUnavailableError");
  });

  test("rejects a payload without a command", async () => {
    setShellTransport(new FakeShellTransport());
    const response = await postShell(SESSION_ONE, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { _tag: string })._tag).toBe("InvalidRequestError");
  });
});

describe("shell registry", () => {
  test("pages output by absolute byte cursor", async () => {
    const id = await runShell("emit ten bytes", { output: "0123456789", exitCode: 0 });

    const tail = (await (await getOutput(id, { cursor: "8" })).json()) as { data: ShellOutput };
    expect(tail.data).toEqual({ output: "89", cursor: 10, size: 10, truncated: false });

    const head = (await (await getOutput(id, { cursor: "0", limit: "4" })).json()) as { data: ShellOutput };
    expect(head.data).toEqual({ output: "0123", cursor: 4, size: 10, truncated: false });

    const next = (await (await getOutput(id, { cursor: "4", limit: "4" })).json()) as { data: ShellOutput };
    expect(next.data).toEqual({ output: "4567", cursor: 8, size: 10, truncated: false });
  });

  test("defaults to a 64KiB page and reports the full size", async () => {
    const output = "x".repeat(DEFAULT_SHELL_OUTPUT_LIMIT + 3);
    const id = await runShell("emit a large output", { output, exitCode: 0 });

    const first = (await (await getOutput(id)).json()) as { data: ShellOutput };
    expect(first.data.output.length).toBe(DEFAULT_SHELL_OUTPUT_LIMIT);
    expect(first.data.cursor).toBe(DEFAULT_SHELL_OUTPUT_LIMIT);
    expect(first.data.size).toBe(DEFAULT_SHELL_OUTPUT_LIMIT + 3);

    const last = (await (await getOutput(id, { cursor: String(DEFAULT_SHELL_OUTPUT_LIMIT) })).json()) as {
      data: ShellOutput;
    };
    expect(last.data.output).toBe("xxx");
    expect(last.data.cursor).toBe(DEFAULT_SHELL_OUTPUT_LIMIT + 3);
  });

  test("lists and gets the retained record inside a location envelope", async () => {
    const id = await runShell("echo hi", { output: "hi\n", exitCode: 1 });

    const listResponse = await listShells({ "location[directory]": process.cwd() });
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { location: { directory: string }; data: ShellInfo[] };
    expect(listed.location.directory).toBe(process.cwd());
    expect(listed.data.map((shell) => shell.id)).toEqual([id]);

    const getResponse = await getShell(id);
    expect(getResponse.status).toBe(200);
    const got = (await getResponse.json()) as { location: { directory: string }; data: ShellInfo };
    expect(got.data.id).toBe(id);
    expect(got.data.exit).toBe(1);
    expect(got.data.cwd).toBe(process.cwd());
  });

  test("records retained for another location stay out of the list", async () => {
    await runShell("echo hi", { output: "hi\n", exitCode: 0 });
    const other = await listShells({ "location[directory]": "/tmp/elsewhere" });
    const body = (await other.json()) as { data: ShellInfo[] };
    expect(body.data).toEqual([]);
  });

  test("unknown ids answer 404 ShellNotFoundError", async () => {
    const missing = "sh_missing";
    for (const response of [await getShell(missing), await getOutput(missing)]) {
      expect(response.status).toBe(404);
      const body = (await response.json()) as { _tag: string; id: string };
      expect(body._tag).toBe("ShellNotFoundError");
      expect(body.id).toBe(missing);
    }
  });

  test("remove drops the record so later reads answer 404", async () => {
    const id = await runShell("echo hi", { output: "hi\n", exitCode: 0 });
    expect((await removeShell(id)).status).toBe(204);
    expect((await getShell(id)).status).toBe(404);
    expect((await getOutput(id)).status).toBe(404);
    expect(await listData()).toEqual([]);
  });

  test("rejects a malformed cursor", async () => {
    const id = await runShell("echo hi", { output: "hi\n", exitCode: 0 });
    const response = await getOutput(id, { cursor: "not-a-cursor" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { _tag: string })._tag).toBe("InvalidRequestError");
  });
});
