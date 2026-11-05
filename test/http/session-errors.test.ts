import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { setCatalogTransport } from "../../src/http/handlers/catalogs";
import { resetForms, setFormTransport } from "../../src/http/handlers/form";
import { resetPermissions, setPermissionTransport } from "../../src/http/handlers/permission";
import {
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
} from "../../src/http/handlers/session-write";
import { setSessionReadTransport } from "../../src/http/handlers/sessions";
import { setSessionWriteTransport } from "../../src/http/handlers/prompt";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";
import { SessionMap } from "../../src/model/session-map";
import { SenpiTransportError, mapSenpiError } from "../../src/senpi/errors";
import type {
  SenpiEntriesResult,
  SenpiMessages,
  SenpiModelInfo,
  SenpiOpenSessionResult,
  SenpiSelectedModel,
  SenpiSessionState,
  SenpiSessionSummary,
} from "../../src/senpi/transport";

const PASSWORD = "session-errors-password";
const KNOWN = "ses_known_1";
const UNKNOWN = "ses_ec089f9efffeBwse1XZRg7Nil1";
const ROUTING_ID = "rpc-known-1";

class FakeHost {
  readonly sessionId = ROUTING_ID;
  readonly streaming = false;
  readonly raw = { request: async <T>(): Promise<T> => ({}) as T };
  constructor(readonly rows: SenpiSessionSummary[]) {}

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [...this.rows];
  }

  async getState(): Promise<SenpiSessionState> {
    return { sessionId: ROUTING_ID, isStreaming: false } as SenpiSessionState;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: [], leafId: null };
  }

  async getMessages(): Promise<SenpiMessages> {
    return [];
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }

  async prompt(): Promise<never> {
    throw new Error("prompt is not used by this fixture");
  }

  async steer(): Promise<never> {
    throw new Error("steer is not used by this fixture");
  }

  async followUp(): Promise<never> {
    throw new Error("followUp is not used by this fixture");
  }

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    return [{ provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true }];
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    return { provider, id } as SenpiSelectedModel;
  }

  async sendExtensionUIResponse(): Promise<void> {}
}

/** A connected transport whose host answers every call with the host's own unknown-session refusal. */
class UnknownSessionHost extends FakeHost {
  override async setModel(): Promise<SenpiSelectedModel> {
    throw mapSenpiError(Object.assign(new Error("unknown_session"), { errorCode: "unknown_session" }));
  }
}

/** A host that is genuinely gone: nothing about this is a not-found answer. */
class DisconnectedHost extends FakeHost {
  override async listSessions(): Promise<SenpiSessionSummary[]> {
    throw new SenpiTransportError("transport_gone", "the private senpi host is detached");
  }

  override async setModel(): Promise<SenpiSelectedModel> {
    throw new SenpiTransportError("transport_gone", "the private senpi host is detached");
  }
}

let server!: BridgeServer;
let base!: string;
let root!: string;
let workdir!: string;
let host!: FakeHost;

const KNOWN_ROW: SenpiSessionSummary = {
  sessionId: ROUTING_ID,
  durableSessionId: KNOWN,
  cwd: "",
  name: "Known session",
  status: "open",
  sessionPath: "",
};

function wire(next: FakeHost): void {
  setSessionReadTransport(next);
  setSessionManagementTransport(next);
  setCatalogTransport(next);
  setSessionWriteTransport(next);
  setPermissionTransport(next);
  setFormTransport(next);
}

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...auth(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function expectSessionNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  const body = await bodyOf(response);
  expect(body._tag).toBe("SessionNotFoundError");
  expect(body.sessionID).toBe(UNKNOWN);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-session-errors-"));
  workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });

  const map = SessionMap.open({ stateDir: join(root, "state"), agentDir: join(root, "agent") });
  host = new FakeHost([{ ...KNOWN_ROW, cwd: workdir, sessionPath: join(workdir, "known.jsonl") }]);
  for (const row of host.rows) map.upsert(row);
  map.flush();

  resetPermissions();
  resetForms();
  setSessionManagementStore(sessionManagementStore(map));
  wire(host);

  server = createServer(
    resolveConfig({
      OMO_BRIDGE_PORT: "0",
      OMO_BRIDGE_PASSWORD: PASSWORD,
      OMO_BRIDGE_STATE_DIR: join(root, "state"),
    }),
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  wire(host);
  setSessionReadTransport(undefined);
  setSessionManagementTransport(undefined);
  setSessionWriteTransport(undefined);
  setCatalogTransport(undefined);
  setPermissionTransport(undefined);
  setFormTransport(undefined);
  setSessionManagementStore(undefined);
  resetPermissions();
  resetForms();
  rmSync(root, { recursive: true, force: true });
});

describe("unknown session over the mounted router", () => {
  test("switch model answers 404 SessionNotFoundError instead of 503", async () => {
    const response = await send("POST", `/api/session/${UNKNOWN}/model`, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });
    await expectSessionNotFound(response);
  });

  test("switch agent answers 404 SessionNotFoundError", async () => {
    const response = await send("POST", `/api/session/${UNKNOWN}/agent`, { agent: "build" });
    await expectSessionNotFound(response);
  });

  test("prompt answers 404 SessionNotFoundError", async () => {
    const response = await send("POST", `/api/session/${UNKNOWN}/prompt`, { parts: [{ type: "text", text: "hi" }] });
    await expectSessionNotFound(response);
  });

  test("permission create answers 404 SessionNotFoundError", async () => {
    const response = await send("POST", `/api/session/${UNKNOWN}/permission`, {
      action: "read",
      resources: ["/tmp/x.txt"],
    });
    await expectSessionNotFound(response);
  });

  test("form create answers 404 SessionNotFoundError", async () => {
    const response = await send("POST", `/api/session/${UNKNOWN}/form`, {
      title: "Unknown",
      fields: [{ key: "ok", type: "boolean" }],
    });
    await expectSessionNotFound(response);
  });

  test("the known session still answers its own statuses", async () => {
    const model = await send("POST", `/api/session/${KNOWN}/model`, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });
    expect(model.status).toBe(204);
    const agent = await send("POST", `/api/session/${KNOWN}/agent`, { agent: "build" });
    expect(agent.status).toBe(204);
  });
});

describe("a host that reports the session itself as unknown", () => {
  test("the transport's session_not_found answers 404 with the path's session id", async () => {
    wire(new UnknownSessionHost(host.rows));
    const response = await send("POST", `/api/session/${KNOWN}/model`, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body._tag).toBe("SessionNotFoundError");
    expect(body.sessionID).toBe(KNOWN);
    wire(host);
  });
});

describe("a genuinely disconnected transport", () => {
  test("switch model still answers 503 ServiceUnavailableError", async () => {
    wire(new DisconnectedHost(host.rows));
    const response = await send("POST", `/api/session/${KNOWN}/model`, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body._tag).toBe("ServiceUnavailableError");
    wire(host);
  });
});
