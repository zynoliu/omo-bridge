import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import { decodeHostEvent } from "../../../packages/bridge-core/src/host-event.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { createEventSurface } from "../../../packages/bridge-core/src/event-surface.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";
import { createSessionSurface } from "../../../packages/bridge-core/src/opencode-surface.ts";
import { createPartSurface } from "../../../packages/bridge-core/src/part-surface.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { Result, Schema, SchemaParser } from "../../../packages/schema/node_modules/effect/dist/index.js";
import { EventManifest } from "../../../packages/schema/src/event-manifest.ts";
import { SessionMessage } from "../../../packages/schema/src/session-message.ts";
import { stageProviderCredential } from "./model-credential.ts";

/**
 * Session lifecycle over the real host, so capability-matrix rows P-606, P-607 and P-618 rest on runtime
 * evidence instead of a mock. Removal (P-609) is deliberately absent: this protocol exposes no remove
 * command, and asserting an absence here would dress up an unimplemented capability as a pass.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** The next event the stream delivers, or nothing when it stays silent for the whole bound. */
async function nextEvent<T>(iterator: AsyncIterator<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const result = await Promise.race([iterator.next(), silence]);
    if (result === undefined || result.done === true) return undefined;
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function eventField(event: unknown, read: (frame: Record<string, unknown>) => unknown): unknown {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  return read(event as Record<string, unknown>);
}

const titleOf = (event: unknown): string | undefined => {
  const data = eventField(event, (frame) => frame.data);
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const title = (data as Record<string, unknown>).title;
  return typeof title === "string" ? title : undefined;
};

const typeOf = (event: unknown): string | undefined => {
  const type = eventField(event, (frame) => frame.type);
  return typeof type === "string" ? type : undefined;
};

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const artifacts: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-matrix-session-"));
  const container = "bridge-qa-matrix-session-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    const key = process.env.BRIDGE_QA_MODEL_KEY;
    const args = ["run", "-d", "--name", container];
    if (key !== undefined && key.length > 0) args.push("-e", "OPENCODE_API_KEY=" + key);
    docker([...args, IMAGE, "sleep", "infinity"]);
    if (key !== undefined && key.length > 0) {
      /* The host keeps provider credentials in its agent directory and reads no provider environment
         variable, so a real turn needs the document written before the daemon starts. */
      stageProviderCredential(container, key);
      docker([
        "exec",
        container,
        "bash",
        "-lc",
        "mkdir -p /home/bridge/.omo/agent && printf '{\"defaultModel\":\"opencode-go/deepseek-v4.1-flash\"}' > /home/bridge/.omo/agent/settings.json",
      ]);
    }
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 80), started.indexOf("lifecycle") !== -1);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({ socketPath: path.join(scratch, "bridge.sock"), container: container, containerSocket: CONTAINER_SOCKET });
    const data = new BridgeData();
    const transport = await openBridgeTransport(
      {
        socket: gateway.socketPath,
        keyRecord: keyRecord,
        cwd: "/work",
        mini: false,
        handshakeTimeoutMs: 20_000,
      },
      /* The launcher publishes every host frame into its data store; a case that subscribes to the
         shipping event stream has to do the same or the projector never sees a frame. */
      (frame) => data.publishEvent(frame),
    );
    record("transport-authenticated", "authenticated", transport.report.state, transport.report.state === "authenticated");

    /* P-606: creating through the surface must yield an id the host itself acknowledges. */
    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];
    record(
      "P-606-session-create",
      "the host answers open_session with a session id",
      sessionId === undefined ? JSON.stringify(opened).slice(0, 120) : "sessionId " + sessionId,
      sessionId !== undefined && sessionId.length > 0,
    );

    /* P-607: reading it back must return the same session. The host answers open_session with a routing id
       (`rpc-1`) and keeps a durable id for the same session, so the read is made against the durable one the
       pull returned rather than against the routing id. */
    await pullHostState(transport, data, new SessionRegistry());
    const held = data.hostSessionList() as readonly { id?: string; location?: { directory?: string } }[];
    const durable = held[0]?.id;
    const surface = createSessionSurface(data);
    let readBack: { readonly id?: string } | undefined;
    let readError = "";
    if (durable !== undefined) {
      try {
        readBack = (await surface.session.get({ id: durable })) as { readonly id?: string };
      } catch (error) {
        readError = String(error).slice(0, 120);
      }
    }
    record(
      "P-607-session-get",
      "the session held by the host is readable back by its durable id",
      readError.length > 0 ? readError : String(readBack?.id),
      readError.length === 0 && durable !== undefined && readBack?.id === durable,
    );

    /* P-618: the location a session reports is the working directory the host holds for it. */
    record(
      "P-618-location-get",
      "/work as the host holds it for the opened session",
      String(held[0]?.location?.directory),
      held.length === 1 && held[0]?.location?.directory === "/work",
    );

    /* The honest scope for these three: the host declares the method (method_classes in get_protocol_info)
       and accepts it here. Acceptance is not the same as equivalence, so the matrix rows stay unverified
       until a case shows the behaviour the row describes. */
    /* These commands address a session by its routing id, not by the durable id get_state uses; the first
       attempt below shows what the durable id gets, and the retry is what the host actually accepts. */
    const addressFirst = async (command: string, payload: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
      const attempts: { id: string; text: string; ok: boolean }[] = [];
      for (const id of [durable, sessionId]) {
        if (id === undefined) continue;
        try {
          const answer = (await transport.request(command, { ...payload, sessionId: id })) as { success?: boolean };
          attempts.push({ id: id, text: JSON.stringify(answer).slice(0, 90), ok: answer.success === true });
        } catch (error) {
          attempts.push({ id: id, text: String(error).slice(0, 90), ok: false });
        }
      }
      const accepted = attempts.find((attempt) => attempt.ok);
      return { ok: accepted !== undefined, text: attempts.map((attempt) => attempt.id + "->" + attempt.text).join(" | ").slice(0, 200) };
    };
    const renamed = await addressFirst("set_session_name", { name: "renamed by qa" });
    const renameAnswer = renamed.text;
    const renameOk = renamed.ok;
    record("accepted-set_session_name", "the host accepts a rename request", renameAnswer, renameOk);

    /* Semantics for the rename: the new name must come back through the state read, otherwise the TUI would
       show the old title forever. get_state is addressed by the routing id — its *response* is what carries
       the durable id, which the launcher checks against the status it read. */
    let stateText = "";
    let renameVisible = false;
    if (durable !== undefined) {
      try {
        const state = (await transport.request("get_state", { sessionId: sessionId })) as { data?: unknown };
        const payload = JSON.stringify(state.data ?? null);
        const renamed = payload.indexOf("renamed by qa") !== -1;
        renameVisible = renamed;
        const keys = state.data !== null && typeof state.data === "object" ? Object.keys(state.data as object).join(",") : "none";
        stateText = (renamed ? "name present; " : "name absent; ") + "keys " + keys.slice(0, 160);
      } catch (error) {
        stateText = String(error).slice(0, 120);
      }
    }
    record(
      "rename-visible-in-the-state",
      "the new name is what the state read reports",
      stateText,
      renameVisible,
    );

    const interrupted = await addressFirst("interrupt", {});
    const interruptAnswer = interrupted.text;
    const interruptOk = interrupted.ok;
    record("accepted-interrupt", "the host accepts an interrupt on an idle session", interruptAnswer, interruptOk);

    const followed = await addressFirst("follow_up", { message: "queued by qa" });
    const followAnswer = followed.text;
    const followOk = followed.ok;
    record("accepted-follow_up", "the host accepts a queued follow-up", followAnswer, followOk);

    /* Semantics, not just acceptance: a queued follow-up must come back in the queue read, otherwise the
       TUI would draw an empty queue for a message the host accepted. */
    let queueText = "";
    if (sessionId !== undefined) {
      try {
        const queue = (await transport.request("get_follow_up_messages", { sessionId: sessionId })) as { data?: unknown };
        queueText = JSON.stringify(queue.data ?? null).slice(0, 160);
      } catch (error) {
        queueText = String(error).slice(0, 120);
      }
    }
    record(
      "follow-up-visible-in-the-queue",
      "the queued message is readable back",
      queueText,
      queueText.indexOf("queued by qa") !== -1,
    );

    /* steer lands in its own queue, and clearing the follow-up queue must actually empty it. */
    let steerText = "";
    let steerOk = false;
    let clearedText = "";
    let clearedOk = false;
    if (sessionId !== undefined) {
      try {
        const steered = (await transport.request("steer", { sessionId: sessionId, message: "steered by qa" })) as {
          success?: boolean;
        };
        steerOk = steered.success === true;
        const read = (await transport.request("get_steering_messages", { sessionId: sessionId })) as { data?: unknown };
        steerText = JSON.stringify(read.data ?? null).slice(0, 140);
      } catch (error) {
        steerText = String(error).slice(0, 120);
      }
      try {
        const cleared = (await transport.request("clear_queue", { sessionId: sessionId })) as { success?: boolean };
        clearedOk = cleared.success === true;
        const after = (await transport.request("get_follow_up_messages", { sessionId: sessionId })) as { data?: unknown };
        clearedText = JSON.stringify(after.data ?? null).slice(0, 140);
      } catch (error) {
        clearedText = String(error).slice(0, 120);
      }
    }
    record(
      "steer-visible-in-the-steering-queue",
      "a steered message reads back on the routing id",
      steerOk ? steerText : "steer refused: " + steerText,
      steerOk && steerText.indexOf("steered by qa") !== -1,
    );
    record(
      "clear-queue-empties-the-follow-up-queue",
      "the queued follow-up is gone after clear_queue",
      clearedText,
      clearedOk && clearedText.indexOf("queued by qa") === -1,
    );


    /* fork refuses a change entry ("Invalid entry ID for forking") and a fresh session's tree holds only
       `model_change` and `thinking_level_change`, so a fork needs a real turn to exist first. Running that turn
       needs a provider the host can reach; the container's models are the OpenCode Go ones, whose quota the
       person reported exhausted. The probe therefore stops at the refusal and says why, instead of dressing
       up "no provider" as "no fork". */
    let forkText = "";
    if (sessionId !== undefined) {
      try {
        const forked = (await transport.request("fork", { sessionId: sessionId })) as { success?: boolean; error?: string };
        forkText = JSON.stringify(forked).slice(0, 180);
      } catch (error) {
        forkText = String(error).slice(0, 140);
      }
    }
    let entriesText = "";
    let entryTypes: string[] = [];
    if (sessionId !== undefined) {
      try {
        const entries = (await transport.request("get_entries", { sessionId: sessionId })) as { data?: unknown };
        entryTypes = Array.from(JSON.stringify(entries.data ?? null).matchAll(/"type":"([a-z_]+)"/g)).map((hit) => hit[1] ?? "");
        entriesText = JSON.stringify(entries.data ?? null).slice(0, 200);
      } catch (error) {
        entriesText = String(error).slice(0, 140);
      }
    }
    record(
      "fork-refuses-a-change-entry",
      "the host names the reason instead of forking at a change entry",
      forkText,
      forkText.indexOf("Invalid entry ID for forking") !== -1,
    );
    record(
      "no-message-entry-before-a-turn",
      "the tree holds no message entry to fork at, because no turn has run",
      "types " + entryTypes.slice(0, 5).join(",") + " (" + String(entryTypes.length) + ")",
      entryTypes.length > 0 && entryTypes.every((kind) => kind.indexOf("message") === -1),
    );

    /* What would session switching need? Both declared methods are tried and their answers recorded, so the
       bridge's missing switching path is described by measurement rather than by the grep alone. */
    const switchAnswers: string[] = [];
    const listed = (await transport.request("list_sessions", {})) as { data?: unknown };
    const sessionPath = JSON.stringify(listed.data ?? null).match(/"sessionPath":"([^"]+)"/)?.[1];
    /* The first attempts show the host wants neither the routing id nor only that id, so the session path a
       listing reports is tried as the address. */
    const candidates = [sessionId, sessionPath].filter((value): value is string => value !== undefined);
    for (const address of candidates) {
      for (const command of ["switch_session", "attach_session"]) {
        try {
          const answer = (await transport.request(command, { sessionId: address })) as { success?: boolean; error?: string };
          switchAnswers.push(command + "(" + address.slice(0, 22) + ")->" + (answer.success === true ? "accepted" : String(answer.error).slice(0, 50)));
        } catch (error) {
          switchAnswers.push(command + "(" + address.slice(0, 22) + ")->" + String(error).slice(0, 50));
        }
      }
    }
    record(
      "switch-session-probe",
      "the host answers the switching methods the bridge never calls",
      switchAnswers.join("; ").slice(0, 180),
      switchAnswers.length > 0,
    );

    /* P-619: the host publishes no frame for a rename, so the pull's diff is the update channel. The
       stream below is the shipping one (`createBridgeOpencodeApi().event`), not a test double. */
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/work" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const renameStream = new AbortController();
    const renames = api.event.subscribe({ types: ["session.renamed"], signal: renameStream.signal })[Symbol.asyncIterator]();
    const connected = await nextEvent(renames, 5_000);
    record(
      "P-619-event-stream-attached",
      "the client stream opens with server.connected",
      String(typeOf(connected)),
      typeOf(connected) === "server.connected",
    );

    /* The earlier rename has not been pulled yet, so this pull is the one that first sees it. */
    await pullHostState(transport, data);
    const firstRename = await nextEvent(renames, 5_000);
    record(
      "P-619-renamed-event-from-the-pull",
      "the pull's diff publishes session.renamed carrying the host's new title",
      String(typeOf(firstRename)) + " " + String(titleOf(firstRename)),
      typeOf(firstRename) === "session.renamed" && titleOf(firstRename) === "renamed by qa",
    );
    record(
      "P-619-renamed-event-in-the-client-vocabulary",
      "the published type is a member of the client's server event manifest",
      String(typeOf(firstRename)),
      typeOf(firstRename) !== undefined && EventManifest.Server.has(typeOf(firstRename) as string),
    );

    /* A pull that reports the same title again must publish nothing, so the next event the stream
       delivers is the second rename's; a duplicate would have arrived first with the old title. */
    await pullHostState(transport, data);
    const secondName = await addressFirst("set_session_name", { name: "renamed twice by qa" });
    await pullHostState(transport, data);
    const secondRename = await nextEvent(renames, 5_000);
    record(
      "P-619-no-duplicate-on-an-unchanged-pull",
      "an unchanged pull publishes nothing, so the next rename carries the second title",
      (secondName.ok ? "" : "rename refused; ") + String(typeOf(secondRename)) + " " + String(titleOf(secondRename)),
      secondName.ok && typeOf(secondRename) === "session.renamed" && titleOf(secondRename) === "renamed twice by qa",
    );

    /* P-648: message ids are minted in the client's msg_ scheme from the host entry the pull binds,
       and the host entry id travels in metadata instead of as the id. `append_user_message` is the one
       documented way to give the host a message without a provider turn, so this needs no credential. */
    const firstAppend = await addressFirst("append_user_message", { content: "first appended by qa" });
    await pullHostState(transport, data);
    const afterFirst = data.hostMessagesFor(durable ?? "");
    const secondAppend = await addressFirst("append_user_message", { content: "second appended by qa" });
    await pullHostState(transport, data);
    const afterSecond = data.hostMessagesFor(durable ?? "");
    const appended = firstAppend.ok && secondAppend.ok;
    const ids = afterSecond.map((message) => message.id);
    const shape = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
    record(
      "P-648-msg-id-scheme",
      "every pulled message carries a client msg_ id instead of the host entry id",
      appended ? ids.join(",") : "append refused: " + firstAppend.text.slice(0, 80),
      appended && ids.length === 2 && ids.every((id) => shape.test(id)),
    );
    record(
      "P-648-msg-id-stable-across-pulls",
      "the already pulled message keeps its id after a second pull",
      String(afterFirst[0]?.id) + " -> " + String(afterSecond[0]?.id),
      afterFirst.length === 1 && afterSecond.length === 2 && afterFirst[0]?.id === afterSecond[0]?.id,
    );
    record(
      "P-648-msg-ids-distinct",
      "two host messages never share a minted id",
      ids.join(","),
      ids.length === 2 && ids[0] !== undefined && ids[0] !== ids[1],
    );
    const entriesAnswer = await transport.request("get_entries", { sessionId: sessionId });
    const entryRows = ((entriesAnswer.data as { entries?: readonly Record<string, unknown>[] } | undefined)?.entries ?? []).filter(
      (row) => row.type === "message",
    );
    const hostEntryIds = entryRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
    const carried = afterSecond.flatMap((message) => {
      const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
      const hostEntryID = metadata?.hostEntryID;
      return typeof hostEntryID === "string" ? [hostEntryID] : [];
    });
    record(
      "P-648-host-entry-in-metadata",
      "each host entry id appears only in metadata, never as the message id",
      carried.join(",") + " / host entries " + hostEntryIds.join(","),
      carried.length === 2 && carried.every((entry) => hostEntryIds.includes(entry) && !ids.includes(entry)),
    );

    /* P-619 archive and move: the row is about whether this host has either at all. The probe reads the
       host's own declaration, calls only names that exist, and records every name the host refuses, so
       the row's answer is measurement instead of a grep. */
    const protocol = JSON.stringify(((await transport.request("get_protocol_info", {})) as { data?: unknown }).data ?? null);
    const declared = [...new Set(Array.from(protocol.matchAll(/"([a-z][a-z0-9_]{2,60})"/g)).map((hit) => hit[1] ?? ""))].filter(
      (name) => name.length > 0,
    );
    const archiveNames = ["archive_session", "unarchive_session", "set_session_archived", "session_archive"];
    const archiveAnswers: string[] = [];
    for (const command of archiveNames) {
      try {
        const answer = (await transport.request(command, { sessionId })) as { success?: boolean; error?: string };
        archiveAnswers.push(command + "->" + String(answer.success === true ? "accepted" : answer.error).slice(0, 60));
      } catch (error) {
        archiveAnswers.push(command + "->" + String(error).slice(0, 60));
      }
    }
    const stateKeys = Object.keys(((await transport.request("get_state", { sessionId })) as { data?: object }).data ?? {});
    const archiveFields = stateKeys.filter((field) => /archiv|trash|hidden|folder|pinned/i.test(field));
    const declaredArchive = declared.filter((name) => /archiv|trash|hidden/i.test(name));
    record(
      "P-619-no-archive-on-this-host",
      "no archive command is declared or accepted, and no session record carries an archive field to diff",
      archiveAnswers.join("; ").slice(0, 180) +
        " | declared " +
        JSON.stringify(declaredArchive) +
        " | state fields " +
        String(stateKeys.length) +
        " archive-like " +
        JSON.stringify(archiveFields),
      declaredArchive.length === 0 &&
        archiveFields.length === 0 &&
        archiveAnswers.every((line) => line.includes("Unknown command")),
    );

    /* `move_session` does exist, so the move half is answered by what it does: it is a session-file
       relocation (`export`/`import`/`prepare`/`finish`) that never touches `get_state.cwd`, which is the
       only field the pull's diff could observe a move on. */
    const moveStatus = (await transport.request("move_session", { sessionId, moveId: "qa-move-1", op: "status" })) as {
      success?: boolean;
      data?: unknown;
      error?: string;
    };
    const moveExport = (await transport.request("move_session", { sessionId, moveId: "qa-move-2", op: "export" })) as {
      success?: boolean;
      error?: string;
      errorData?: { readonly detail?: string };
    };
    const moveCwd = ((await transport.request("get_state", { sessionId })) as { data?: { cwd?: string } }).data?.cwd;
    record(
      "P-619-move-is-a-relocation-protocol-not-a-cwd-change",
      "move_session exists, is a session-file relocation and leaves get_state.cwd unchanged, so the diff has no field change to observe",
      "declared " +
        String(declared.includes("move_session")) +
        " status " +
        JSON.stringify(moveStatus.data ?? moveStatus.error).slice(0, 80) +
        " export " +
        String(moveExport.errorData?.detail ?? moveExport.error).slice(0, 110) +
        " cwd " +
        String(moveCwd),
      declared.includes("move_session") &&
        moveStatus.success === true &&
        (moveExport.errorData?.detail ?? "").includes("sessionPath") &&
        moveCwd === "/work",
    );
    try {
      writeFileSync(
        path.join(context.out, "move-archive-probe.json"),
        JSON.stringify(
          {
            declaredMatching: declared.filter((name) => /archiv|move|cwd|directory|trash|hidden/i.test(name)),
            archiveNames,
            archiveAnswers,
            archiveFields,
            moveStatus: moveStatus.data ?? moveStatus.error,
            moveExport: moveExport.errorData ?? moveExport.error,
            cwdAfterMoveAttempts: moveCwd,
            stateKeys,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      artifacts.push("move-archive-probe.json");
    } catch (error) {
      detail.push("probe artifact write failed: " + String(error).slice(0, 100));
    }

    /* P-648 live: the host names no live message record at all (measured: `message_start`,
       `message_update`, `message_end`, `turn_start` and `turn_end` carry no id), so only a real turn can
       show that the projector mints client ids instead of handing a host id through. */
    if (key === undefined || key.length === 0) {
      record(
        "P-648-live-ids-and-parts",
        "a real turn's projected events carry client msg_ ids and its parts read back as part_ ids",
        "BRIDGE_QA_MODEL_KEY is not set, so no real turn can run",
        false,
      );
    } else {
      await transport.request("set_model", { sessionId, provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
      const liveStream = new AbortController();
      const liveEvents = api.event.subscribe({ signal: liveStream.signal })[Symbol.asyncIterator]();
      const attached = await nextEvent(liveEvents, 5_000);
      await transport.request("prompt", {
        sessionId,
        message: "Do not use any tools. Reply with exactly: OK",
        clientMessageId: "msg-case-live-1",
      });
      const collected: unknown[] = [];
      const deadline = Date.now() + 120_000;
      let finished = false;
      while (!finished && Date.now() < deadline) {
        const event = await nextEvent(liveEvents, Math.max(1_000, deadline - Date.now()));
        if (event === undefined) break;
        collected.push(event);
        const type = typeOf(event);
        finished = type === "session.execution.succeeded" || type === "session.execution.interrupted";
      }
      const named = collected.flatMap((event) => {
        const data = eventField(event, (frame) => frame.data);
        if (typeof data !== "object" || data === null) return [];
        const record = data as Record<string, unknown>;
        const id = record.assistantMessageID ?? record.messageID;
        return typeof id === "string" ? [{ type: String(typeOf(event)), id }] : [];
      });
      const decoded = collected.map((event) =>
        decodeHostEvent({
          ...(event as Record<string, unknown>),
          id: "evt_" + String((event as Record<string, unknown>).id).replace(/^bridge-/, ""),
        }),
      );
      const refused = decoded.flatMap((result) => (result.ok ? [] : [result.reason]));
      /* The client's decoder also brands the session id (`ses...`), which this bridge carries as the
         host's durable id; that is a separate gap this check does not own. What it owns is the message
         id, so that field is judged by the client's own `SessionMessage.ID` schema. */
      const acceptsClientMessageID = (id: string) =>
        Result.isSuccess(SchemaParser.decodeUnknownResult(Schema.toEncoded(SessionMessage.ID))(id));
      const accepted = named.filter((entry) => acceptsClientMessageID(entry.id));
      const hostIDAsMessageID = named.filter((entry) => hostEntryIds.includes(entry.id));
      record(
        "P-648-live-events-carry-client-ids",
        "a real turn names every message with an id the client's SessionMessage.ID schema accepts, and never with the host entry id",
        "attached " +
          String(typeOf(attached)) +
          ", " +
          String(collected.length) +
          " event(s), " +
          String(named.length) +
          " naming a message, accepted by SessionMessage.ID " +
          String(accepted.length) +
          "/" +
          String(named.length) +
          ", host entry ids used as message ids " +
          String(hostIDAsMessageID.length) +
          "; decodeHostEvent still refuses " +
          String(refused.length) +
          " event(s) for the session-id brand (a separate gap) first " +
          JSON.stringify(named.slice(0, 2)).slice(0, 120),
        collected.length > 0 &&
          named.length > 0 &&
          accepted.length === named.length &&
          hostIDAsMessageID.length === 0,
      );

      await pullHostState(transport, data);
      const turned = durable === undefined ? [] : data.hostMessagesFor(durable);
      const pulledIDs = new Set(turned.map((message) => message.id));
      const liveIDs = collected.flatMap((event) => {
        if (typeOf(event) !== "session.message.content.updated") return [];
        const data = eventField(event, (frame) => frame.data);
        const id = typeof data === "object" && data !== null ? (data as Record<string, unknown>).messageID : undefined;
        return typeof id === "string" ? [id] : [];
      });
      record(
        "P-648-live-and-pulled-views-agree",
        "the message id a live content update names is the id the pulled transcript carries for that row",
        "live " + JSON.stringify(liveIDs).slice(0, 120) + " pulled " + String(pulledIDs.size) + " id(s)",
        liveIDs.length > 0 && liveIDs.some((id) => pulledIDs.has(id)),
      );

      const assistant =
        turned.find((message) => message.type === "assistant" && liveIDs.includes(message.id)) ??
        turned.find((message) => message.type === "assistant");
      const viewSession = data.view().sessions[0]?.id;
      if (viewSession !== undefined) data.select(viewSession);
      const readParts = async () =>
        assistant === undefined || viewSession === undefined
          ? []
          : await createPartSurface(data).part.list({ sessionID: viewSession, messageID: assistant.id });
      const parts = await readParts();
      const reread = await readParts();
      await pullHostState(transport, data);
      const afterPull = await readParts();
      const partShape = /^part_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
      const idsOf = (list: readonly { readonly id: string }[]) => JSON.stringify(list.map((part) => part.id));
      record(
        "P-648-parts-of-a-real-turn",
        "the assistant message of a real turn answers client part_ ids, stable across two reads and across a further pull",
        String(parts.length) +
          " part(s): " +
          JSON.stringify(parts.map((part) => part.type + ":" + part.id)).slice(0, 170),
        parts.length > 0 &&
          parts.every((part) => partShape.test(part.id)) &&
          idsOf(parts) === idsOf(reread) &&
          idsOf(parts) === idsOf(afterPull),
      );
      liveStream.abort();
    }

    renameStream.abort();
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

  return {
    checks: checks,
    cleanup: { ok: checks.every((check) => check.pass), detail: detail },
    artifacts: artifacts,
    /* The live half needs a real turn: without a credential this run can answer the other checks but
       cannot claim what the live ids or the parts of a real turn are. */
    ...(process.env.BRIDGE_QA_MODEL_KEY === undefined || process.env.BRIDGE_QA_MODEL_KEY.length === 0
      ? { blocked: true }
      : {}),
  };
}
