import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponse } from "../../src/contract/validate";
import {
  handleSessionCommand,
  handleSessionCreate,
  handleSessionPrompt,
  handleSessionSynthetic,
  resetPromptAdmissions,
  setSessionWriteTransport,
  type PromptCommand,
  type PromptCommandChannel,
  type SessionWriteTransport,
} from "../../src/http/handlers/prompt";
import type {
  SenpiEntriesResult,
  SenpiImages,
  SenpiOpenSessionOptions,
  SenpiOpenSessionResult,
  SenpiPromptOptions,
  SenpiPromptResult,
  SenpiQueuedDisposition,
  SenpiSessionState,
  SenpiSessionSummary,
  SenpiSteerRecovery,
} from "../../src/senpi/transport";

type PromptCall = { message: string; options: SenpiPromptOptions | undefined };

class FakeTransport implements SessionWriteTransport {
  sessionId: string | undefined = "rpc-1";
  rows: SenpiSessionSummary[] = [];
  streaming = false;
  nextDisposition: "started" | "queued" | "handled" = "started";
  commandSurface: Array<{ name: string }> | undefined = [{ name: "fix-tests" }];
  readonly prompts: PromptCall[] = [];
  readonly steers: Array<{ message: string; recovery: SenpiSteerRecovery | undefined }> = [];
  readonly followUps: Array<{ message: string; recovery: SenpiSteerRecovery | undefined }> = [];
  readonly opens: SenpiOpenSessionOptions[] = [];
  readonly names: string[] = [];
  readonly entries: unknown[] = [];

  readonly raw: PromptCommandChannel = {
    request: async <T>(command: PromptCommand): Promise<T> => {
      if (command.type === "set_session_name") {
        this.names.push(command.name);
        return {} as T;
      }
      if (this.commandSurface === undefined) throw new Error("this host does not list commands");
      return { commands: this.commandSurface } as T;
    },
  };

  async openSession(options: SenpiOpenSessionOptions = {}): Promise<SenpiOpenSessionResult> {
    this.opens.push(options);
    if (options.sessionPath !== undefined) {
      const existing = this.rows.find((row) => row.sessionPath === options.sessionPath);
      if (existing !== undefined) this.sessionId = existing.sessionId;
      return { sessionId: this.sessionId ?? "rpc-1" } as SenpiOpenSessionResult;
    }
    const created = {
      sessionId: "rpc-created",
      durableSessionId: "durable-created",
      cwd: options.cwd ?? process.cwd(),
      status: "open",
    } as SenpiSessionSummary;
    this.rows = [created, ...this.rows];
    this.sessionId = created.sessionId;
    return { sessionId: created.sessionId } as SenpiOpenSessionResult;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [...this.rows];
  }

  async getState(): Promise<SenpiSessionState> {
    return { sessionId: this.sessionId, isStreaming: this.streaming } as unknown as SenpiSessionState;
  }

  async prompt(message: string, options?: SenpiPromptOptions): Promise<SenpiPromptResult> {
    this.prompts.push({ message, options });
    this.entries.push({ type: "message", message: { role: "user" } });
    return this.nextDisposition;
  }

  async steer(message: string, _images?: SenpiImages, recovery?: SenpiSteerRecovery): Promise<SenpiQueuedDisposition> {
    this.steers.push({ message, recovery });
    this.entries.push({ type: "message", message: { role: "user" } });
    return "queued";
  }

  async followUp(message: string, _images?: SenpiImages, recovery?: SenpiSteerRecovery): Promise<SenpiQueuedDisposition> {
    this.followUps.push({ message, recovery });
    this.entries.push({ type: "message", message: { role: "user" } });
    return "queued";
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: this.entries, leafId: null } as unknown as SenpiEntriesResult;
  }
}

let workDir: string;
let transport: FakeTransport;
let sessionPath: string;

function row(overrides: Record<string, unknown> = {}): SenpiSessionSummary {
  return {
    sessionId: "rpc-1",
    durableSessionId: "durable-1",
    sessionPath,
    cwd: workDir,
    status: "open",
    ...overrides,
  } as SenpiSessionSummary;
}

function url(path: string): URL {
  return new URL(`http://bridge.test${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`http://bridge.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "prompt-http-"));
  sessionPath = join(workDir, "session.jsonl");
  transport = new FakeTransport();
  transport.rows = [row()];
  setSessionWriteTransport(transport);
  resetPromptAdmissions();
});

afterEach(() => {
  setSessionWriteTransport(undefined);
  resetPromptAdmissions();
  rmSync(workDir, { recursive: true, force: true });
});

describe("POST /api/session", () => {
  test("opens a retained session and answers the mapped public info", async () => {
    const response = await handleSessionCreate(
      post("/api/session", { title: "Alpha", location: { directory: workDir } }),
      url("/api/session"),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const info = body.data as Record<string, unknown>;

    expect(validateResponse("session.publicInfo", info)).toEqual({ ok: true });
    expect(info.id).toBe("durable-created");
    expect(info.title).toBe("Alpha");
    expect(info.location).toEqual({ directory: workDir });
    expect(transport.opens).toEqual([{ cwd: workDir, retainOnDisconnect: true }]);
    expect(transport.names).toEqual(["Alpha"]);
  });

  test("defaults the location to the process cwd and skips an absent title", async () => {
    const response = await handleSessionCreate(post("/api/session", {}), url("/api/session"));
    expect(response.status).toBe(200);
    const info = (await bodyOf(response)).data as Record<string, unknown>;
    expect(transport.opens[0]?.cwd).toBe(process.cwd());
    expect(transport.names).toEqual([]);
    expect(typeof info.title).toBe("string");
  });

  test("answers 503 when no transport is wired", async () => {
    setSessionWriteTransport(undefined);
    const response = await handleSessionCreate(post("/api/session", {}), url("/api/session"));
    expect(response.status).toBe(503);
    expect((await bodyOf(response))._tag).toBe("ServiceUnavailableError");
  });
});

describe("POST /api/session/:sessionID/prompt", () => {
  test("joins every text part into one message", async () => {
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", {
        parts: [
          { type: "text", text: "say" },
          { type: "text", text: "hi" },
        ],
      }),
      url("/api/session/durable-1/prompt"),
    );
    expect(response.status).toBe(200);
    const data = (await bodyOf(response)).data as Record<string, unknown>;
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]?.message).toBe("say\nhi");
    expect(data.type).toBe("user");
    expect(data.sessionID).toBe("durable-1");
    expect(data.payload).toEqual({ text: "say\nhi" });
    expect(data.disposition).toBe("started");
    expect(data.state).toBe("running");
  });

  test("maps a data: file part onto a senpi image block", async () => {
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", {
        parts: [
          { type: "text", text: "look" },
          { type: "file", mime: "image/png", url: "data:image/png;base64,QUJD" },
        ],
      }),
      url("/api/session/durable-1/prompt"),
    );
    expect(response.status).toBe(200);
    expect(transport.prompts[0]?.options?.images).toEqual([
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
    const data = (await bodyOf(response)).data as Record<string, unknown>;
    expect((data.payload as Record<string, unknown>).files).toEqual([{ uri: "data:image/png;base64,QUJD" }]);
  });

  test("sends a repeated clientMessageId exactly once and replays its admission", async () => {
    const body = { id: "message-1", parts: [{ type: "text", text: "hi" }] };
    const first = await bodyOf(
      await handleSessionPrompt(post("/api/session/durable-1/prompt", body), url("/api/session/durable-1/prompt")),
    );
    const entriesAfterFirst = (await transport.getEntries()).entries.length;
    const second = await bodyOf(
      await handleSessionPrompt(post("/api/session/durable-1/prompt", body), url("/api/session/durable-1/prompt")),
    );

    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]?.options?.clientMessageId).toBe("message-1");
    expect((await transport.getEntries()).entries.length).toBe(entriesAfterFirst);
    expect(second.data).toEqual(first.data);
    expect((second.data as Record<string, unknown>).id).toBe("message-1");
  });

  test("takes metadata.clientMessageId when the body has no id", async () => {
    const body = { parts: [{ type: "text", text: "hi" }], metadata: { clientMessageId: "metadata-id" } };
    await handleSessionPrompt(post("/api/session/durable-1/prompt", body), url("/api/session/durable-1/prompt"));
    await handleSessionPrompt(post("/api/session/durable-1/prompt", body), url("/api/session/durable-1/prompt"));
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0]?.options?.clientMessageId).toBe("metadata-id");
  });

  test("reports state completed when the host handled the input without a run", async () => {
    transport.nextDisposition = "handled";
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "hi" }] }),
      url("/api/session/durable-1/prompt"),
    );
    const data = (await bodyOf(response)).data as Record<string, unknown>;
    expect(data.disposition).toBe("handled");
    expect(data.state).toBe("completed");
  });

  test("steers a streaming session when delivery is steer", async () => {
    transport.streaming = true;
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "stop that" }], delivery: "steer" }),
      url("/api/session/durable-1/prompt"),
    );
    expect(response.status).toBe(200);
    expect(transport.steers.map((call) => call.message)).toEqual(["stop that"]);
    expect(transport.prompts).toHaveLength(0);
  });

  test("queues a follow-up on a streaming session for the default delivery", async () => {
    transport.streaming = true;
    await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "next" }] }),
      url("/api/session/durable-1/prompt"),
    );
    expect(transport.followUps.map((call) => call.message)).toEqual(["next"]);
    expect(transport.prompts).toHaveLength(0);
  });

  test("prompts an idle session even when delivery asks for steer", async () => {
    await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "fresh" }], delivery: "steer" }),
      url("/api/session/durable-1/prompt"),
    );
    expect(transport.prompts.map((call) => call.message)).toEqual(["fresh"]);
    expect(transport.steers).toHaveLength(0);
  });

  test("re-attaches by path when the transport holds another session", async () => {
    transport.sessionId = "rpc-other";
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "hi" }] }),
      url("/api/session/durable-1/prompt"),
    );
    expect(response.status).toBe(200);
    expect(transport.opens).toEqual([{ sessionPath, retainOnDisconnect: true }]);
  });

  test("refuses a different held session that has no path to reopen", async () => {
    transport.sessionId = "rpc-other";
    transport.rows = [row({ sessionPath: undefined })];
    const response = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [{ type: "text", text: "hi" }] }),
      url("/api/session/durable-1/prompt"),
    );
    expect(response.status).toBe(409);
    expect((await bodyOf(response))._tag).toBe("ConflictError");
    expect(transport.prompts).toHaveLength(0);
  });

  test("answers 404 for an unknown session and 400 for an empty prompt", async () => {
    const missing = await handleSessionPrompt(
      post("/api/session/nope/prompt", { parts: [{ type: "text", text: "hi" }] }),
      url("/api/session/nope/prompt"),
    );
    expect(missing.status).toBe(404);
    expect((await bodyOf(missing))._tag).toBe("SessionNotFoundError");

    const empty = await handleSessionPrompt(
      post("/api/session/durable-1/prompt", { parts: [] }),
      url("/api/session/durable-1/prompt"),
    );
    expect(empty.status).toBe(400);
    expect((await bodyOf(empty))._tag).toBe("InvalidRequestError");
  });
});

describe("POST /api/session/:sessionID/synthetic", () => {
  test("prompts with the synthetic text and its client message id", async () => {
    const response = await handleSessionSynthetic(
      post("/api/session/durable-1/synthetic", { id: "synthetic-1", text: "editor context", description: "ctx" }),
      url("/api/session/durable-1/synthetic"),
    );
    expect(response.status).toBe(200);
    const data = (await bodyOf(response)).data as Record<string, unknown>;
    expect(transport.prompts.map((call) => call.message)).toEqual(["editor context"]);
    expect(transport.prompts[0]?.options?.clientMessageId).toBe("synthetic-1");
    expect(data.type).toBe("synthetic");
    expect(data.payload).toEqual({ text: "editor context", description: "ctx" });
  });
});

describe("POST /api/session/:sessionID/command", () => {
  test("sends /name plus its arguments as the prompt text", async () => {
    const response = await handleSessionCommand(
      post("/api/session/durable-1/command", { name: "fix-tests", arguments: "--all" }),
      url("/api/session/durable-1/command"),
    );
    expect(response.status).toBe(204);
    expect(transport.prompts.map((call) => call.message)).toEqual(["/fix-tests --all"]);
  });

  test("accepts a leading slash and empty arguments", async () => {
    const response = await handleSessionCommand(
      post("/api/session/durable-1/command", { name: "/fix-tests" }),
      url("/api/session/durable-1/command"),
    );
    expect(response.status).toBe(204);
    expect(transport.prompts.map((call) => call.message)).toEqual(["/fix-tests"]);
  });

  test("refuses a command the host does not list, without sending anything", async () => {
    const response = await handleSessionCommand(
      post("/api/session/durable-1/command", { name: "nope" }),
      url("/api/session/durable-1/command"),
    );
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(body._tag).toBe("CommandNotFoundError");
    expect(body.command).toBe("nope");
    expect(transport.prompts).toHaveLength(0);
  });

  test("passes the command through when the host cannot list its surface", async () => {
    transport.commandSurface = undefined;
    const response = await handleSessionCommand(
      post("/api/session/durable-1/command", { name: "anything" }),
      url("/api/session/durable-1/command"),
    );
    expect(response.status).toBe(204);
    expect(transport.prompts.map((call) => call.message)).toEqual(["/anything"]);
  });
});
