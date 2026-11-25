import { describe, expect, test } from "bun:test";

import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

import { UnsupportedCapability } from "../src/client.ts";
import { UnimplementedApiGroup } from "../src/client-surface.ts";
import { BridgeData } from "../src/data.ts";
import { createEventSurface } from "../src/event-surface.ts";
import { createBridgeOpencodeApi } from "../src/opencode-api.ts";
import { createSessionSurface } from "../src/opencode-surface.ts";
import { createPartSurface } from "../src/part-surface.ts";

const hostSession: SessionInfo = {
  id: "ses_host",
  projectID: "prj_host",
  title: "Host session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/work/project" },
};

const hostMessage: SessionMessageInfo = {
  id: "msg_host",
  time: { created: 3 },
  text: "hello",
  type: "user",
};

function build() {
  const data = new BridgeData();
  const api = createBridgeOpencodeApi({
    data,
    defaultLocation: { directory: "/workspace" },
    events: createEventSurface(),
    sessions: createSessionSurface(data),
    parts: createPartSurface(data),
  });
  return { data, api };
}

describe("createBridgeOpencodeApi", () => {
  test("construction does not throw", () => {
    expect(() => build()).not.toThrow();
  });

  test("session.list returns the stored payload without a projection", async () => {
    const { data, api } = build();
    data.upsertHostSession(hostSession);
    const page = await api.session.list();
    expect(page.data.length).toBe(1);
    expect(page.data[0]).toBe(hostSession);
    expect(page.cursor).toEqual({});
  });

  test("session.get returns the stored payload instead of a projection", async () => {
    const { data, api } = build();
    data.upsertHostSession(hostSession);
    expect(await api.session.get({ sessionID: "ses_host" })).toBe(hostSession);
  });

  test("session.get refuses a session the host never delivered", async () => {
    const { api } = build();
    await expect(api.session.get({ sessionID: "ses_missing" })).rejects.toThrow(UnsupportedCapability);
  });

  test("session.message.get returns the stored message", async () => {
    const { data, api } = build();
    data.upsertHostSession(hostSession);
    data.setHostMessages("ses_host", [hostMessage]);
    expect(await api.session.message.get({ sessionID: "ses_host", messageID: "msg_host" })).toBe(hostMessage);
  });

  test("session.message.get refuses a message the host never delivered", async () => {
    const { data, api } = build();
    data.setHostMessages("ses_host", [hostMessage]);
    await expect(api.session.message.get({ sessionID: "ses_host", messageID: "msg_missing" })).rejects.toThrow(
      UnsupportedCapability,
    );
  });

  test("session.message.editAssistantMessage hands the caller's input to the injected host member", async () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/workspace" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      editAssistantMessage: async (input) => {
        seen.push(input);
        return { outcome: "edited", leafID: "a2", entryID: "a2" };
      },
    });
    const outcome = await api.session.message.editAssistantMessage({
      sessionID: "ses_host",
      messageID: "msg_host",
      text: "corrected",
      expectedLeafID: "a1",
    });
    expect(outcome).toEqual({ outcome: "edited", leafID: "a2", entryID: "a2" });
    expect(seen).toEqual([{ sessionID: "ses_host", messageID: "msg_host", text: "corrected", expectedLeafID: "a1" }]);
  });

  test("session.message.editAssistantMessage refuses without an injected host member", async () => {
    const { api } = build();
    await expect(
      api.session.message.editAssistantMessage({ sessionID: "ses_host", messageID: "msg_host", text: "corrected" }),
    ).rejects.toThrow(UnsupportedCapability);
  });

  test("session.environment rejects instead of throwing so the caller's catch sees it", async () => {
    const { api } = build();
    // The TUI calls this from an effect and handles the failure with `.catch(toast.error)`; a
    // synchronous throw escapes that handler and takes the whole app down.
    await expect(api.session.environment({ sessionID: "ses_host", variables: { TERM: "xterm-256color" } })).rejects.toThrow(
      UnsupportedCapability,
    );
  });

  test("an unimplemented member throws with its group and member", () => {
    const { api } = build();
    expect(() => api.session.remove({ sessionID: "ses_host" })).toThrow(UnimplementedApiGroup);
    try {
      api.session.remove({ sessionID: "ses_host" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnimplementedApiGroup);
      if (error instanceof UnimplementedApiGroup) {
        expect(error.group).toBe("session");
        expect(error.member).toBe("remove");
        expect(error.message).toBe("UNIMPLEMENTED_API_GROUP: session.remove");
      }
    }
  });

  test("session.create refuses without an injected creator instead of admitting a local session", async () => {
    const { api } = build();
    await expect(api.session.create({})).rejects.toThrow(UnsupportedCapability);
  });

  test("session.create hands the client-minted id and parent to the host opener", async () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/workspace" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      createSession: async (input) => {
        seen.push(input);
        return hostSession;
      },
    });
    const opened = await api.session.create({ id: "ses_minted", parentID: "ses_parent", location: { directory: "/w" } });
    expect(opened).toBe(hostSession);
    expect(seen).toEqual([{ id: "ses_minted", parentID: "ses_parent", directory: "/w" }]);
  });

  test("session.fork passes the fork boundary through and refuses without an injected forker", async () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/workspace" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      forkSession: async (input) => {
        seen.push(input);
        return hostSession;
      },
    });
    expect(await api.session.fork({ sessionID: "ses_host", before: "entry_1" })).toBe(hostSession);
    expect(seen).toEqual([{ sessionID: "ses_host", before: "entry_1" }]);
    const bare = build().api;
    await expect(bare.session.fork({ sessionID: "ses_host" })).rejects.toThrow(UnsupportedCapability);
  });

  test("session.revert delegates each member and reports the staged boundary", async () => {
    const data = new BridgeData();
    const calls: string[] = [];
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/workspace" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      revertStage: async (input) => {
        calls.push("stage:" + input.messageID + ":" + String(input.files));
        return { messageID: input.messageID };
      },
      revertCommit: async () => {
        calls.push("commit");
      },
      revertClear: async () => {
        calls.push("clear");
      },
    });
    expect(await api.session.revert.stage({ sessionID: "ses_host", messageID: "u2" })).toEqual({ messageID: "u2" });
    await api.session.revert.commit({ sessionID: "ses_host" });
    await api.session.revert.clear({ sessionID: "ses_host" });
    expect(calls).toEqual(["stage:u2:undefined", "commit", "clear"]);
    const bare = build().api;
    await expect(bare.session.revert.stage({ sessionID: "ses_host", messageID: "u2" })).rejects.toThrow(UnsupportedCapability);
    await expect(bare.session.revert.clear({ sessionID: "ses_host" })).rejects.toThrow(UnsupportedCapability);
    await expect(bare.session.revert.commit({ sessionID: "ses_host" })).rejects.toThrow(UnsupportedCapability);
  });

  test("session.switchModel forwards the composer's variant, which is the host thinking level", async () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: "/workspace" },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
      switchModel: async (input) => {
        seen.push(input);
        return undefined;
      },
    });
    await api.session.switchModel({ sessionID: "ses_host", model: { providerID: "p", id: "m", variant: "high" } });
    expect(seen).toEqual([{ sessionID: "ses_host", providerID: "p", modelID: "m", variant: "high" }]);
  });

  test("the event stream opens with server.connected and stays open until it is aborted", async () => {
    const { api } = build();
    const controller = new AbortController();
    const iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.done === false ? first.value.type : "closed").toBe("server.connected");
    // The TUI treats a stream that ends immediately as a dropped connection, so the second read is
    // still pending until the caller aborts it.
    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  test("a nested member reports its path within the group", () => {
    const { api } = build();
    try {
      api.debug.location.list();
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnimplementedApiGroup);
      if (error instanceof UnimplementedApiGroup) {
        expect(error.message).toBe("UNIMPLEMENTED_API_GROUP: debug.location.list");
      }
    }
  });

  test("unimplemented namespaces return no value at all", () => {
    const { api } = build();
    expect(() => api.mcp.list()).toThrow(UnimplementedApiGroup);
    expect(() => api.config.get()).toThrow(UnimplementedApiGroup);
  });

  test("server.info answers, because the terminal capability is the bridge's own answer", async () => {
    const { api } = build();
    const info = (await api.server.info()) as unknown as { capabilities?: { persistentPty?: boolean } };
    expect(info.capabilities?.persistentPty).toBe(false);
  });

  test("the migration status answers completed: this process holds no store to migrate", async () => {
    const { api } = build();
    const status = (await api.experimental.migration.v1.status()) as { status: string };
    expect(status.status).toBe("completed");
  });

  test("plugin.list reports the location directory and an empty catalogue until the host delivers one", async () => {
    const { api, data } = build();
    const listed = await api.plugin.list({});
    expect(listed.location.directory).toBe("/workspace");
    expect(listed.data).toEqual([]);
    data.mergeLocation({ info: { directory: "/workspace/proj", project: { id: "p", directory: "/workspace/proj", canonical: "/workspace/proj" } } });
    const again = await api.plugin.list({});
    expect(again.location.directory).toBe("/workspace/proj");
  });
});
