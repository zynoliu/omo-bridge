import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { setCatalogTransport } from "../../src/http/handlers/catalogs";
import { setSessionWriteTransport, type PromptCommand, type PromptCommandChannel } from "../../src/http/handlers/prompt";
import { resetForms, setFormEventBus, setFormTransport } from "../../src/http/handlers/form";
import {
  resetSessionInboxState,
  setSessionInboxTransport,
  type InboxCommand,
  type InboxCommandChannel,
  type QueueEntry,
  type SessionInboxTransport,
} from "../../src/http/handlers/inbox";
import { setMediaStateDir } from "../../src/http/handlers/media";
import { resetPermissions, setPermissionEventBus, setPermissionTransport } from "../../src/http/handlers/permission";
import {
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
} from "../../src/http/handlers/session-write";
import { setSessionReadTransport } from "../../src/http/handlers/sessions";
import { resetShells, setShellEventBus, setShellTransport } from "../../src/http/handlers/shell";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";
import { SessionMap } from "../../src/model/session-map";
import type {
  SenpiAbortAnswer,
  SenpiAbortOptions,
  SenpiEntriesResult,
  SenpiImages,
  SenpiMessages,
  SenpiModelInfo,
  SenpiOpenSessionResult,
  SenpiPromptOptions,
  SenpiPromptResult,
  SenpiQueuedDisposition,
  SenpiSessionState,
  SenpiSessionSummary,
  SenpiSelectedModel,
  SenpiSteerRecovery,
} from "../../src/senpi/transport";

export const SURFACE_PASSWORD = "surface-password";
export const SURFACE_SESSION = "ses_surface_1";
export const SURFACE_DELETE_SESSION = "ses_surface_delete";
const ROUTING_ID = "rpc-surface-1";
const MODEL: SenpiModelInfo = { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true };

export type SurfaceBridge = {
  server: BridgeServer;
  base: string;
  workdir: string;
  sessionID: string;
  throwawaySessionID: string;
  auth(): Record<string, string>;
  close(): Promise<void>;
};

class FakeSenpi {
  readonly sessionId = ROUTING_ID;
  readonly streaming = false;
  rows: SenpiSessionSummary[];
  readonly state: SenpiSessionState;
  readonly responses: Array<Record<string, unknown>> = [];
  private readonly workdir: string;

  constructor(rows: SenpiSessionSummary[], workdir: string) {
    this.rows = rows;
    this.workdir = workdir;
    this.state = { sessionId: ROUTING_ID, isStreaming: false } as SenpiSessionState;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [...this.rows];
  }

  async getState(): Promise<SenpiSessionState> {
    return this.state;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: [], leafId: null };
  }

  async getMessages(): Promise<SenpiMessages> {
    return [];
  }

  async sendExtensionUIResponse(response: unknown): Promise<void> {
    this.responses.push(response as Record<string, unknown>);
  }

  async setSessionName(name: string): Promise<void> {
    this.responses.push({ type: "set_session_name", name });
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }

  async unloadSession(options: unknown): Promise<void> {
    this.responses.push({ type: "unload_session", options });
  }

  async closeSession(): Promise<void> {
    this.responses.push({ type: "close_session" });
  }

  async compact(): Promise<unknown> {
    return { compacted: true };
  }

  async fork(entryId: string): Promise<{ cancelled?: boolean; text?: string }> {
    this.responses.push({ type: "fork", entryId });
    return { cancelled: false };
  }

  async clone(): Promise<{ cancelled?: boolean }> {
    this.rows = [
      ...this.rows,
      {
        sessionId: "rpc-surface-cloned",
        durableSessionId: "ses_surface_cloned",
        cwd: this.workdir,
        name: "Cloned",
        status: "open",
        sessionPath: join(this.workdir, "cloned.jsonl"),
      },
    ];
    return { cancelled: false };
  }

  async revertStage(options: { messageID: string; files?: boolean }): Promise<{ data: Record<string, unknown> }> {
    return { data: { messageID: options.messageID, staged: true } };
  }

  async revertClear(): Promise<void> {
    this.responses.push({ type: "revert_clear" });
  }

  async revertCommit(): Promise<void> {
    this.responses.push({ type: "revert_commit" });
  }

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    return [MODEL];
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    return { provider, id } as SenpiSelectedModel;
  }

  async getCommands(): Promise<readonly { name: string; description?: string }[]> {
    return [{ name: "surface", description: "Surface probe" }];
  }

  async prompt(message: string, _options?: SenpiPromptOptions): Promise<SenpiPromptResult> {
    this.responses.push({ type: "prompt", message });
    return "started" as SenpiPromptResult;
  }

  async steer(
    message: string,
    _images?: SenpiImages,
    _recovery?: SenpiSteerRecovery,
  ): Promise<SenpiQueuedDisposition> {
    this.responses.push({ type: "steer", message });
    return "queued";
  }

  async followUp(
    message: string,
    _images?: SenpiImages,
    _recovery?: SenpiSteerRecovery,
  ): Promise<SenpiQueuedDisposition> {
    this.responses.push({ type: "follow_up", message });
    return "queued";
  }

  readonly raw: PromptCommandChannel = {
    request: async <T>(_command: PromptCommand): Promise<T> => ({ commands: [] }) as T,
  };
}

class FakeInbox implements SessionInboxTransport {
  readonly sessionId = ROUTING_ID;
  ordered: QueueEntry[] = [];
  pending: unknown[] = [];
  readonly aborts: Array<SenpiAbortOptions | undefined> = [];
  readonly commands: InboxCommand[] = [];
  readonly raw: InboxCommandChannel = {
    request: async <T>(command: InboxCommand): Promise<T> => {
      this.commands.push(structuredClone(command));
      return { status: "removed" } as T;
    },
  };

  async abort(options?: SenpiAbortOptions): Promise<SenpiAbortAnswer> {
    this.aborts.push(options);
    return undefined as SenpiAbortAnswer;
  }

  async getState(): Promise<SenpiSessionState> {
    return { sessionId: ROUTING_ID, isStreaming: false, ordered: this.ordered } as unknown as SenpiSessionState;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [
      {
        sessionId: ROUTING_ID,
        durableSessionId: SURFACE_SESSION,
        cwd: process.cwd(),
        status: "open",
        sessionPath: join(process.cwd(), "surface.jsonl"),
      } as SenpiSessionSummary,
    ];
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }

  async getPendingInputs(): Promise<unknown> {
    return { inputs: this.pending };
  }
}

export function startSurfaceBridge(): SurfaceBridge {
  const root = mkdtempSync(join(tmpdir(), "omo-bridge-surface-"));
  const workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "note.txt"), "surface\n");

  const map = SessionMap.open({ stateDir: join(root, "state"), agentDir: join(root, "agent") });
  const rows: SenpiSessionSummary[] = [
    {
      sessionId: ROUTING_ID,
      durableSessionId: SURFACE_SESSION,
      cwd: workdir,
      name: "Surface session",
      status: "open",
      sessionPath: join(workdir, "surface.jsonl"),
    },
    {
      sessionId: "rpc-surface-delete",
      durableSessionId: SURFACE_DELETE_SESSION,
      cwd: workdir,
      name: "Throwaway session",
      status: "open",
      sessionPath: join(workdir, "delete.jsonl"),
    },
  ];
  for (const row of rows) map.upsert(row);
  map.flush();

  const fake = new FakeSenpi(rows, workdir);
  const inbox = new FakeInbox();
  resetSessionInboxState();
  setSessionInboxTransport(inbox);
  setSessionReadTransport(fake);
  setSessionWriteTransport(fake);
  setSessionManagementTransport(fake);
  setSessionManagementStore(sessionManagementStore(map));
  setPermissionTransport(fake);
  setPermissionEventBus(undefined);
  resetPermissions();
  setFormTransport(fake);
  setFormEventBus(undefined);
  resetForms();
  setCatalogTransport(fake);
  setShellTransport({
    bash: async (command: string) => ({ output: `${command}\n`, exitCode: 0 }),
  });
  resetShells();
  setShellEventBus(undefined);
  setMediaStateDir(join(root, "media"));

  const server = createServer(
    resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: SURFACE_PASSWORD, OMO_BRIDGE_STATE_DIR: join(root, "state") }),
  );

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    workdir,
    sessionID: SURFACE_SESSION,
    throwawaySessionID: SURFACE_DELETE_SESSION,
    auth: () => ({ authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${SURFACE_PASSWORD}`, "utf8").toString("base64")}` }),
    async close() {
      await server.stop(true);
      setSessionInboxTransport(undefined);
      resetSessionInboxState();
      setSessionReadTransport(undefined);
      setSessionWriteTransport(undefined);
      setSessionManagementTransport(undefined);
      setSessionManagementStore(undefined);
      setPermissionTransport(undefined);
      setPermissionEventBus(undefined);
      resetPermissions();
      setFormTransport(undefined);
      setFormEventBus(undefined);
      resetForms();
      setCatalogTransport(undefined);
      setShellTransport(undefined);
      resetShells();
      setShellEventBus(undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
