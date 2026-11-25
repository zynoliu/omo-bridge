import { statSync } from "node:fs";

import type { LocationRef, OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { SharedEvents } from "../../client/src/shared-events.ts";
import type { MessageChannel } from "../../client/src/message-channel.ts";

import type { BridgeClientDeps } from "./bridge-opencode-client.ts";
import type { ClientApiGroup } from "./client-surface.ts";
import { UnimplementedApiGroup } from "./client-surface.ts";
import { UnsupportedCapability } from "./client.ts";
import type { BridgeData } from "./data.ts";
import { HostEventProjector } from "./host-projection.ts";

export type BridgeOpencodeApiDeps = BridgeClientDeps & {
  readonly data: BridgeData;
  readonly defaultLocation: LocationRef;
  /**
   * The terminal service, when one is available. The fork's persistent PTY service is Effect-based and
   * lives in a package this one must not depend on, so the launcher builds it and passes this plain
   * async surface in. Without it every `experimental.persistentPty` member stays unimplemented.
   */
  readonly pty?: BridgePtySurface;
  /**
   * Switches one session's model on the host. Injected for the same reason as the prompt sender: the
   * transport lives in the launcher. Without it the member keeps reporting the gap.
   */
  readonly switchModel?: (input: {
    readonly sessionID: string;
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
  }) => Promise<unknown>;
  /**
   * Opens a host session, including a child named by its parent, and reports what the host opened.
   * Injected for the same reason as the prompt sender: only the launcher holds the transport.
   */
  readonly createSession?: (input: BridgeSessionCreate) => Promise<SessionInfo>;
  /**
   * Forks the active branch, or clones the whole session, and reports the session the host replaced
   * this connection's view with. The host answers `fork` with the forked prompt's text, not a session.
   */
  readonly forkSession?: (input: { readonly sessionID: string; readonly before?: string }) => Promise<SessionInfo>;
  /** Stages the revert boundary the client shows; the host keeps no staged revert of its own. */
  readonly revertStage?: (input: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly files?: boolean;
  }) => Promise<{ readonly messageID: string }>;
  readonly revertCommit?: (input: { readonly sessionID: string }) => Promise<void>;
  readonly revertClear?: (input: { readonly sessionID: string }) => Promise<void>;
  /** `edit_user_message`: the transcript-side edit, carried by the client's message channel. */
  readonly editMessage?: MessageChannel["edit"];
  /** `edit_assistant_message`: the assistant-side edit, carried by the same channel. */
  readonly editAssistantMessage?: MessageChannel["editAssistantMessage"];
  /** `continue_from_leaf`: a turn from the session's current leaf, no new user prompt. */
  readonly continueFromLeaf?: MessageChannel["continueFromLeaf"];
};

/**
 * The client surface this adapter answers, plus the message-channel members the generated client has no
 * place for. The extra members are on the same namespaces, so a caller reads one object either way.
 */
export type BridgeClientApi = OpenCodeClient & {
  readonly session: OpenCodeClient["session"] & {
    readonly message: OpenCodeClient["session"]["message"] & MessageChannel;
  };
};

/** What `session.create` asks for, mapped onto the documented `open_session` fields. */
export type BridgeSessionCreate = {
  readonly id?: string;
  readonly parentID?: string;
  readonly title?: string;
  readonly directory?: string;
};

/** One running terminal as the host service reports it. */
export type BridgePtyInfo = { readonly id: string } & Record<string, unknown>;

/** One terminal snapshot: the replayed screen plus the attachment state. */
export type BridgePtySnapshot = Record<string, unknown>;

/**
 * What a terminal service has to answer for this adapter, in the shapes the client surface uses. All
 * of it is plain promises: the caller never sees an Effect.
 */
export type BridgePtySurface = {
  readonly list: (sessionID?: string) => Promise<readonly BridgePtyInfo[]>;
  readonly get: (id: string) => Promise<BridgePtyInfo>;
  readonly create: (
    sessionID: string,
    input: {
      readonly command?: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly title: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cols?: number;
      readonly rows?: number;
    },
  ) => Promise<BridgePtyInfo>;
  readonly snapshot: (id: string) => Promise<BridgePtySnapshot>;
  readonly read: (sessionID: string, lines?: number) => Promise<unknown>;
  readonly resize: (id: string, cols: number, rows: number, attachmentID?: string) => Promise<void>;
  readonly input: (id: string, attachmentID: string, cols: number, rows: number, data: Uint8Array) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly rename: (id: string, title: string | null) => Promise<BridgePtyInfo>;
  readonly shutdown: () => Promise<void>;
  readonly handoff: () => Promise<unknown>;
};

type UnimplementedMember = (...args: readonly unknown[]) => never;

function unimplemented(group: ClientApiGroup, member: string): UnimplementedMember {
  return () => {
    throw new UnimplementedApiGroup(group, member);
  };
}

type ConnectedEvent = Extract<OpenCodeEvent, { readonly type: "server.connected" }>;

/**
 * The TUI takes its connection state from this stream: it is connected only once the stream's first
 * event is `server.connected` and the stream stays open afterwards. In bridge mode the attachment is
 * the launcher's already-authenticated socket, which is up before the TUI starts, so that handshake
 * reports the bridge's own transport state rather than a host payload.
 *
 * Every later event is a projection of a frame the launcher published into `BridgeData`: the host
 * never emits the client vocabulary itself, so `host-projection.ts` maps its lifecycle, message and
 * dialog frames onto it.
 *
 * The keepalive is the same 15 s server comment the HTTP client expects (packages/client/src/solid/
 * connection.ts: `defaultIdleTimeout` 45 s, "the server writes a keepalive comment every 15 seconds"):
 * `onActivity` fires every 15 s while the stream is open, so a subscriber's watchdog sees three ticks
 * per idle window and a silent transport is still detected after 45 s by its own timeout, not here.
 */
function bridgeEventGroup(data: BridgeData, location: LocationRef): OpenCodeClient["event"] {
  return SharedEvents.make((signal, onActivity) => bridgeConnectionEvents(data, location, signal, onActivity));
}

const KEEPALIVE_MS = 15_000;
/* The shared event hub drops a subscriber past 4096 queued events; the same bound applies here so a
   reader that never pulls cannot grow this queue without limit. */
const EVENT_QUEUE_LIMIT = 4_096;

async function* bridgeConnectionEvents(
  data: BridgeData,
  location: LocationRef,
  signal: AbortSignal,
  onActivity: () => void,
): AsyncGenerator<ConnectedEvent | OpenCodeEvent> {
  yield { id: "bridge-connected", type: "server.connected", data: {} };
  const projector = new HostEventProjector({ location: location, ids: data.ids });
  const queue: OpenCodeEvent[] = [];
  let wake: (() => void) | undefined;
  const enqueue = (events: readonly OpenCodeEvent[]) => {
    if (events.length === 0) return;
    queue.push(...events);
    if (queue.length > EVENT_QUEUE_LIMIT) queue.splice(0, queue.length - EVENT_QUEUE_LIMIT);
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  let aborted = signal.aborted;
  const onAbort = () => {
    aborted = true;
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = data.subscribeEvents((frame) => {
    enqueue(projector.project(frame));
  });
  /* Events derived from host state rather than projected from a frame (`session-diff.ts`) reach the same
     subscriber; `projector.stats()` counts frames only, so they are neither re-projected nor ignored. */
  const unsubscribeClient = data.subscribeClientEvents((event) => {
    enqueue([event as OpenCodeEvent]);
  });
  const keepalive = setInterval(onActivity, KEEPALIVE_MS);
  try {
    while (!aborted) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) yield next;
      }
      if (aborted) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (aborted) {
          wake = undefined;
          resolve();
        }
      });
    }
  } finally {
    clearInterval(keepalive);
    unsubscribe();
    unsubscribeClient();
    signal.removeEventListener("abort", onAbort);
    /* Frames the projector cannot map are dropped from the stream, so the launcher states the counts
       when the only subscriber closes instead of losing them silently. */
    const projection = projector.stats();
    if (projection.ignored > 0)
      process.stderr.write(
        "bridge-log: event projection: " +
          String(projection.projected) +
          " events projected, " +
          String(projection.ignored) +
          " frames ignored (" +
          projection.ignoredReasons.slice(0, 3).join(" | ") +
          ")\n",
      );
  }
}


/**
 * The terminal group, answered from the injected service. `connectToken` stays unimplemented: the
 * client mints it to open a websocket against the server, and the bridge has no server socket for it;
 * the live stream is served through `client.persistentPty.connect` over the injected attachment.
 */
type PtyGroup = OpenCodeClient["experimental"]["persistentPty"];
type PtyInput<Member extends keyof PtyGroup> = PtyGroup[Member] extends (input: infer Input) => unknown ? Input : never;

/**
 * The fork's persistent PTY service brands session ids as `ses…` and rejects anything else, while the
 * host's durable session ids have no such shape. The bridge maps them deterministically (hex keeps the
 * mapping reversible and collision-free) so a terminal can be created for the session the TUI shows.
 */
export function ptySessionID(sessionID: string): string {
  return /^ses[_]/.test(sessionID) ? sessionID : "ses_" + Buffer.from(sessionID, "utf8").toString("hex");
}

function persistentPtyGroup(pty: BridgePtySurface | undefined, defaultCwd: string): PtyGroup {
  if (pty === undefined) {
    return {
      read: unimplemented("experimental", "persistentPty.read"),
      list: unimplemented("experimental", "persistentPty.list"),
      create: unimplemented("experimental", "persistentPty.create"),
      shutdown: unimplemented("experimental", "persistentPty.shutdown"),
      handoff: unimplemented("experimental", "persistentPty.handoff"),
      get: unimplemented("experimental", "persistentPty.get"),
      update: unimplemented("experimental", "persistentPty.update"),
      snapshot: unimplemented("experimental", "persistentPty.snapshot"),
      remove: unimplemented("experimental", "persistentPty.remove"),
      connectToken: unimplemented("experimental", "persistentPty.connectToken"),
    } as unknown as OpenCodeClient["experimental"]["persistentPty"];
  }
  return {
    read: (input: PtyInput<"read">) => pty.read(ptySessionID(input.sessionID), input.lines) as never,
    list: (input: PtyInput<"list">) => pty.list(input.sessionID === undefined ? undefined : ptySessionID(input.sessionID)) as never,
    create: (input: PtyInput<"create">) =>
      pty.create(ptySessionID(input.sessionID), {
        command: input.command,
        args: input.args,
        cwd: spawnableCwd(input.cwd, defaultCwd),
        title: input.title,
        env: input.env,
        cols: input.size?.cols,
        rows: input.size?.rows,
      }) as never,
    shutdown: () => pty.shutdown() as never,
    handoff: () => pty.handoff() as never,
    get: (input: PtyInput<"get">) => pty.get(input.ptyID) as never,
    /* `update` carries a size, a title, or both: the service has one call for each. */
    update: async (input: PtyInput<"update">) => {
      if (input.attachmentID !== undefined && input.size !== undefined) {
        await pty.resize(input.ptyID, input.size.cols, input.size.rows, input.attachmentID);
      }
      if (input.title !== undefined) await pty.rename(input.ptyID, input.title);
      return (await pty.get(input.ptyID)) as never;
    },
    snapshot: (input: PtyInput<"snapshot">) => pty.snapshot(input.ptyID) as never,
    remove: (input: PtyInput<"remove">) => pty.remove(input.ptyID) as never,
    connectToken: unimplemented("experimental", "persistentPty.connectToken"),
  } as unknown as OpenCodeClient["experimental"]["persistentPty"];
}

/**
 * A terminal cannot be spawned in a directory this machine does not have. The host may publish such a
 * path (a container or fixture cwd), so the bridge's own location stands in instead of failing the pane.
 */
function spawnableCwd(requested: string | undefined, fallback: string): string {
  if (requested === undefined) return fallback;
  try {
    return statSync(requested).isDirectory() ? requested : fallback;
  } catch {
    return fallback;
  }
}

export function createBridgeOpencodeApi(deps: BridgeOpencodeApiDeps): BridgeClientApi {
  return {
    agent: {
      list: unimplemented("agent", "list"),
      get: unimplemented("agent", "get"),
    },
    command: {
      list: unimplemented("command", "list"),
    },
    config: {
      get: unimplemented("config", "get"),
      shells: unimplemented("config", "shells"),
      update: unimplemented("config", "update"),
    },
    credential: {
      list: unimplemented("credential", "list"),
      create: unimplemented("credential", "create"),
      update: unimplemented("credential", "update"),
      activate: unimplemented("credential", "activate"),
      remove: unimplemented("credential", "remove"),
    },
    debug: {
      heapDump: unimplemented("debug", "heapDump"),
      location: {
        list: unimplemented("debug", "location.list"),
        evict: unimplemented("debug", "location.evict"),
      },
    },
    event: bridgeEventGroup(deps.data, deps.defaultLocation),
    experimental: {
      session: {
        stats: unimplemented("experimental", "session.stats"),
        import: unimplemented("experimental", "session.import"),
        export: unimplemented("experimental", "session.export"),
        skill: unimplemented("experimental", "session.skill"),
        wait: unimplemented("experimental", "session.wait"),
        instructions: {
          entry: {
            list: unimplemented("experimental", "session.instructions.entry.list"),
            put: unimplemented("experimental", "session.instructions.entry.put"),
            remove: unimplemented("experimental", "session.instructions.entry.remove"),
          },
        },
        log: unimplemented("experimental", "session.log"),
      },
      generate: {
        text: unimplemented("experimental", "generate.text"),
        image: unimplemented("experimental", "generate.image"),
        decisions: unimplemented("experimental", "generate.decisions"),
      },
      voice: {
        models: unimplemented("experimental", "voice.models"),
        session: unimplemented("experimental", "voice.session"),
      },
      integration: {
        wellknown: {
          add: unimplemented("experimental", "integration.wellknown.add"),
        },
      },
      mcp: {
        add: unimplemented("experimental", "mcp.add"),
        remove: unimplemented("experimental", "mcp.remove"),
        connect: unimplemented("experimental", "mcp.connect"),
        disconnect: unimplemented("experimental", "mcp.disconnect"),
        client: {
          token: unimplemented("experimental", "mcp.client.token"),
        },
      },
      file: {
        write: unimplemented("experimental", "file.write"),
        watch: unimplemented("experimental", "file.watch"),
        unwatch: unimplemented("experimental", "file.unwatch"),
      },
      persistentPty: persistentPtyGroup(deps.pty, deps.defaultLocation.directory),
      /*
       * The TUI polls a v1 data-migration status on mount. The bridge holds no local store of its own to
       * migrate — the host owns the data and this process only reads what the host sends — so the truthful
       * answer is "completed": there is nothing here to migrate. Reporting an error would show a failure
       * toast for a migration that has nothing to do.
       */
      migration: {
        v1: {
          status: (async () => ({ status: "completed" as const })) as never,
        },
      },
      media: {
        get: unimplemented("experimental", "media.get"),
      },
      schedule: {
        create: unimplemented("experimental", "schedule.create"),
        list: unimplemented("experimental", "schedule.list"),
        get: unimplemented("experimental", "schedule.get"),
        pause: unimplemented("experimental", "schedule.pause"),
        resume: unimplemented("experimental", "schedule.resume"),
        delete: unimplemented("experimental", "schedule.delete"),
      },
      artifacts: {
        providers: unimplemented("experimental", "artifacts.providers"),
        list: unimplemented("experimental", "artifacts.list"),
        create: unimplemented("experimental", "artifacts.create"),
        get: unimplemented("experimental", "artifacts.get"),
        update: unimplemented("experimental", "artifacts.update"),
        delete: unimplemented("experimental", "artifacts.delete"),
        view: unimplemented("experimental", "artifacts.view"),
      },
      job: {
        list: unimplemented("experimental", "job.list"),
      },
      usage: {
        limits: unimplemented("experimental", "usage.limits"),
      },
      config: {
        update: unimplemented("experimental", "config.update"),
      },
    },
    file: {
      read: unimplemented("file", "read"),
      list: unimplemented("file", "list"),
      find: unimplemented("file", "find"),
      write: unimplemented("file", "write"),
      watch: unimplemented("file", "watch"),
      unwatch: unimplemented("file", "unwatch"),
    },
    form: {
      list: unimplemented("form", "list"),
    },
    generate: {
      text: unimplemented("generate", "text"),
      image: unimplemented("generate", "image"),
      decisions: unimplemented("generate", "decisions"),
    },
    integration: {
      list: unimplemented("integration", "list"),
      get: unimplemented("integration", "get"),
      connect: {
        key: unimplemented("integration", "connect.key"),
        external: unimplemented("integration", "connect.external"),
      },
      oauth: {
        connect: unimplemented("integration", "oauth.connect"),
        status: unimplemented("integration", "oauth.status"),
        complete: unimplemented("integration", "oauth.complete"),
        cancel: unimplemented("integration", "oauth.cancel"),
      },
      command: {
        connect: unimplemented("integration", "command.connect"),
        status: unimplemented("integration", "command.status"),
        cancel: unimplemented("integration", "command.cancel"),
      },
      wellknown: {
        add: unimplemented("integration", "wellknown.add"),
      },
    },
    location: {
      get: unimplemented("location", "get"),
      reload: unimplemented("location", "reload"),
    },
    mcp: {
      list: unimplemented("mcp", "list"),
      resource: {
        catalog: unimplemented("mcp", "resource.catalog"),
      },
      add: unimplemented("mcp", "add"),
      remove: unimplemented("mcp", "remove"),
      connect: unimplemented("mcp", "connect"),
      disconnect: unimplemented("mcp", "disconnect"),
      client: {
        token: unimplemented("mcp", "client.token"),
      },
    },
    message: {
      list: unimplemented("message", "list"),
    },
    migration: {
      v1: {
        status: unimplemented("migration", "v1.status"),
      },
    },
    model: {
      list: unimplemented("model", "list"),
      default: unimplemented("model", "default"),
    },
    permission: {
      request: {
        list: unimplemented("permission", "request.list"),
      },
      saved: {
        list: unimplemented("permission", "saved.list"),
        update: unimplemented("permission", "saved.update"),
        remove: unimplemented("permission", "saved.remove"),
      },
      create: unimplemented("permission", "create"),
      list: unimplemented("permission", "list"),
      get: unimplemented("permission", "get"),
      reply: unimplemented("permission", "reply"),
    },
    plugin: {
      /* an empty list means the host has not delivered a plugin catalogue yet, never that plugins exist */
      list: async () => ({
        location: { directory: deps.data.location().info?.directory ?? deps.defaultLocation.directory },
        data: deps.data.location().plugin ?? [],
      }),
      gui: unimplemented("plugin", "gui"),
      check: unimplemented("plugin", "check"),
      update: unimplemented("plugin", "update"),
    },
    project: {
      list: unimplemented("project", "list"),
      update: unimplemented("project", "update"),
    },
    provider: {
      list: unimplemented("provider", "list"),
      get: unimplemented("provider", "get"),
    },
    pty: {
      list: unimplemented("pty", "list"),
      create: unimplemented("pty", "create"),
      get: unimplemented("pty", "get"),
      update: unimplemented("pty", "update"),
      remove: unimplemented("pty", "remove"),
      connect: {
        token: unimplemented("pty", "connect.token"),
      },
    },
    reference: {
      list: unimplemented("reference", "list"),
    },
    rpc: Object.assign(unimplemented("rpc", "call"), { call: unimplemented("rpc", "call") }),
    server: {
      /* The terminal surface is offered only when a terminal service was injected: reporting support
         the bridge cannot back would put an entry point in front of the user that fails on use. */
      info: (async () => ({ capabilities: { persistentPty: deps.pty !== undefined } })) as never,
      pair: unimplemented("server", "pair"),
      connect: unimplemented("server", "connect"),
    },
    session: {
      list: async () => ({ data: deps.data.hostSessionList(), cursor: {} }),
      get: async (input) => {
        const session = deps.data.hostSession(input.sessionID);
        if (session === undefined) throw new UnsupportedCapability("session.get");
        return session;
      },
      message: {
        get: async (input) => {
          const message = deps.data.hostMessagesFor(input.sessionID).find((item) => item.id === input.messageID);
          if (message === undefined) throw new UnsupportedCapability("session.message.get");
          return message;
        },
        /*
         * The two host commands the generated channel is missing (P-739). The host keeps no file
         * snapshots, so neither member restores files: `edit` rewrites the transcript from the edited
         * prompt and leaves the abandoned branch in the session file, and `continueFromLeaf` runs a turn
         * from whatever leaf the session is on.
         */
        edit: async (input) => {
          const edit = deps.editMessage;
          if (edit === undefined) throw new UnsupportedCapability("session.message.edit");
          return await edit(input);
        },
        /*
         * The host's `edit_assistant_message`: the reply is replaced with an edited copy, the leaf
         * moves to that entry's parent and the original answer stays in the session file. It restores
         * no files, because the host keeps no snapshots of them.
         */
        editAssistantMessage: async (input) => {
          const edit = deps.editAssistantMessage;
          if (edit === undefined) throw new UnsupportedCapability("session.message.editAssistantMessage");
          return await edit(input);
        },
        continueFromLeaf: async (input) => {
          const run = deps.continueFromLeaf;
          if (run === undefined) throw new UnsupportedCapability("session.message.continueFromLeaf");
          return await run(input);
        },
      },
      create: (async (input: {
        readonly id?: string | null;
        readonly parentID?: string | null;
        readonly title?: string | null;
        readonly location?: { readonly directory: string } | null;
      }) => {
        const createSession = deps.createSession;
        if (createSession === undefined) throw new UnsupportedCapability("session.create");
        return await createSession({
          ...(typeof input.id === "string" ? { id: input.id } : {}),
          ...(typeof input.parentID === "string" ? { parentID: input.parentID } : {}),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
          ...(input.location?.directory === undefined ? {} : { directory: input.location.directory }),
        });
      }) as never,
      active: unimplemented("session", "active"),
      remove: unimplemented("session", "remove"),
      fork: (async (input: { readonly sessionID: string; readonly before?: string }) => {
        const forkSession = deps.forkSession;
        if (forkSession === undefined) throw new UnsupportedCapability("session.fork");
        return await forkSession({
          sessionID: input.sessionID,
          ...(input.before === undefined ? {} : { before: input.before }),
        });
      }) as never,
      switchAgent: unimplemented("session", "switchAgent"),
      switchModel: (async (input: {
        readonly sessionID: string;
        readonly model?: { readonly providerID?: string; readonly id?: string; readonly variant?: string };
      }) => {
        const switchModel = deps.switchModel;
        if (switchModel === undefined) throw new UnsupportedCapability("session.switchModel");
        const providerID = input.model?.providerID;
        const modelID = input.model?.id;
        if (providerID === undefined || modelID === undefined) throw new UnsupportedCapability("session.switchModel");
        return (await switchModel({
          sessionID: input.sessionID,
          providerID: providerID,
          modelID: modelID,
          ...(input.model?.variant === undefined ? {} : { variant: input.model.variant }),
        })) as never;
      }) as never,
      update: unimplemented("session", "update"),
      move: unimplemented("session", "move"),
      prompt: unimplemented("session", "prompt"),
      command: unimplemented("session", "command"),
      synthetic: unimplemented("session", "synthetic"),
      shell: unimplemented("session", "shell"),
      compact: unimplemented("session", "compact"),
      revert: {
        /*
         * Mapping onto the host, which has no staged revert and no file snapshots:
         *   stage  - remember the boundary here; `session.get().revert` reports it so the transcript
         *            cuts at it. `files: true` is refused: the host keeps nothing to restore.
         *   clear  - forget the boundary; the transcript returns to the host's leaf.
         *   commit - `navigate_tree {entryId}` with the default select rule: a user message moves the
         *            leaf to its parent (an empty conversation for the root prompt), and the abandoned
         *            branch stays in the session file rather than being deleted.
         */
        stage: (async (input: { readonly sessionID: string; readonly messageID: string; readonly files?: boolean }) => {
          const stage = deps.revertStage;
          if (stage === undefined) throw new UnsupportedCapability("session.revert.stage");
          return (await stage({
            sessionID: input.sessionID,
            messageID: input.messageID,
            ...(input.files === undefined ? {} : { files: input.files }),
          })) as never;
        }) as never,
        clear: (async (input: { readonly sessionID: string }) => {
          const clear = deps.revertClear;
          if (clear === undefined) throw new UnsupportedCapability("session.revert.clear");
          return (await clear({ sessionID: input.sessionID })) as never;
        }) as never,
        commit: (async (input: { readonly sessionID: string }) => {
          const commit = deps.revertCommit;
          if (commit === undefined) throw new UnsupportedCapability("session.revert.commit");
          return (await commit({ sessionID: input.sessionID })) as never;
        }) as never,
      },
      context: unimplemented("session", "context"),
      diff: unimplemented("session", "diff"),
      inbox: {
        list: unimplemented("session", "inbox.list"),
        cancel: unimplemented("session", "inbox.cancel"),
        update: unimplemented("session", "inbox.update"),
      },
      generate: unimplemented("session", "generate"),
      interrupt: unimplemented("session", "interrupt"),
      background: unimplemented("session", "background"),
      form: {
        list: unimplemented("session", "form.list"),
        create: unimplemented("session", "form.create"),
        get: unimplemented("session", "form.get"),
        reply: unimplemented("session", "form.reply"),
        cancel: unimplemented("session", "form.cancel"),
      },
      /*
       * The host has no command that replaces a session's shell environment, and the bridge spawns no
       * shells for the session, so this rejects rather than reporting variables that were never
       * applied. It rejects instead of throwing so the TUI's own `.catch(toast.error)` at the call
       * site sees it: a synchronous throw from an async member escapes that handler and crashes the app.
       */
      environment: async () => {
        throw new UnsupportedCapability("session.environment");
      },
      view: unimplemented("session", "view"),
      stats: unimplemented("session", "stats"),
      import: unimplemented("session", "import"),
      export: unimplemented("session", "export"),
      skill: unimplemented("session", "skill"),
      wait: unimplemented("session", "wait"),
      instructions: {
        entry: {
          list: unimplemented("session", "instructions.entry.list"),
          put: unimplemented("session", "instructions.entry.put"),
          remove: unimplemented("session", "instructions.entry.remove"),
        },
      },
      log: unimplemented("session", "log"),
    },
    shell: {
      list: unimplemented("shell", "list"),
      create: unimplemented("shell", "create"),
      get: unimplemented("shell", "get"),
      output: unimplemented("shell", "output"),
      remove: unimplemented("shell", "remove"),
    },
    skill: {
      list: unimplemented("skill", "list"),
    },
    usage: {
      limits: unimplemented("usage", "limits"),
    },
    vcs: {
      init: unimplemented("vcs", "init"),
      get: unimplemented("vcs", "get"),
      base: unimplemented("vcs", "base"),
      status: unimplemented("vcs", "status"),
      branch: {
        list: unimplemented("vcs", "branch.list"),
      },
      diff: unimplemented("vcs", "diff"),
    },
    voice: {
      models: unimplemented("voice", "models"),
      session: unimplemented("voice", "session"),
    },
    websearch: {
      providers: unimplemented("websearch", "providers"),
      query: unimplemented("websearch", "query"),
    },
    worktree: {
      list: unimplemented("worktree", "list"),
      create: unimplemented("worktree", "create"),
      remove: unimplemented("worktree", "remove"),
      refresh: unimplemented("worktree", "refresh"),
    },
  };
}
