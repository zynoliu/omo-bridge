import { describe, expect, test } from "bun:test";

import { BridgeClient, UnsupportedCapability } from "../src/client.ts";
import { UnimplementedApiGroup } from "../src/client-surface.ts";
import { DialogRegistry } from "../src/dialogs.ts";
import { InteractionController } from "../src/interaction.ts";
import { SessionRegistry } from "../src/sessions.ts";
import { BridgeData } from "../src/data.ts";
import { createEventSurface } from "../src/event-surface.ts";
import { createBridgeOpencodeApi } from "../src/opencode-api.ts";
import type { BridgePtySurface } from "../src/opencode-api.ts";
import { createPartSurface } from "../src/part-surface.ts";
import { createSessionSurface } from "../src/opencode-surface.ts";

function build(pty?: BridgePtySurface) {
  const data = new BridgeData();
  const api = createBridgeOpencodeApi({
    data,
    defaultLocation: { directory: "/workspace" },
    events: createEventSurface(),
    sessions: createSessionSurface(data),
    parts: createPartSurface(data),
    pty: pty,
  });
  return api;
}

function stubSurface(calls: string[]): BridgePtySurface {
  return {
    list: async (sessionID) => {
      calls.push("list:" + String(sessionID));
      return [{ id: "pty_1" }];
    },
    get: async (id) => {
      calls.push("get:" + id);
      return { id: id };
    },
    create: async (sessionID, input) => {
      calls.push("create:" + sessionID + ":" + input.title);
      return { id: "pty_1" };
    },
    snapshot: async (id) => {
      calls.push("snapshot:" + id);
      return { id: id, lines: ["hello"] };
    },
    read: async (sessionID) => {
      calls.push("read:" + sessionID);
      return null;
    },
    resize: async (id, cols, rows) => {
      calls.push("resize:" + id + ":" + String(cols) + "x" + String(rows));
    },
    input: async (id, attachmentID) => {
      calls.push("input:" + id + ":" + attachmentID);
    },
    remove: async (id) => {
      calls.push("remove:" + id);
    },
    rename: async (id, title) => {
      calls.push("rename:" + id + ":" + String(title));
      return { id: id };
    },
    shutdown: async () => {
      calls.push("shutdown");
    },
    handoff: async () => {
      calls.push("handoff");
      return null;
    },
  };
}

describe("bridge terminal api group", () => {
  test("without a terminal service every member reports the gap instead of answering", () => {
    const api = build();
    expect(() => api.experimental.persistentPty.create({ sessionID: "ses_1", title: "t", args: [], env: {} } as never)).toThrow(
      UnimplementedApiGroup,
    );
  });

  test("a create reaches the service with the terminal the caller asked for", async () => {
    const calls: string[] = [];
    const api = build(stubSurface(calls));
    const info = await api.experimental.persistentPty.create({
      sessionID: "ses_1",
      command: "/bin/sh",
      args: ["-c", "printf hi"],
      title: "shell",
      env: { PATH: "/usr/bin:/bin" },
      size: { cols: 100, rows: 30 },
    } as never);
    expect(calls).toEqual(["create:ses_1:shell"]);
    expect((info as unknown as { id: string }).id).toBe("pty_1");
  });

  test("a snapshot is answered from the same service", async () => {
    const calls: string[] = [];
    const api = build(stubSurface(calls));
    const snapshot = await api.experimental.persistentPty.snapshot({ ptyID: "pty_1" } as never);
    expect(calls).toEqual(["snapshot:pty_1"]);
    expect(JSON.stringify(snapshot)).toContain("hello");
  });

  test("an update carries a size and a title to the calls that own them", async () => {
    const calls: string[] = [];
    const api = build(stubSurface(calls));
    await api.experimental.persistentPty.update({
      ptyID: "pty_1",
      attachmentID: "att_1",
      size: { cols: 120, rows: 40 },
      title: "renamed",
    } as never);
    expect(calls).toEqual(["resize:pty_1:120x40", "rename:pty_1:renamed", "get:pty_1"]);
  });

  test("remove reaches the service and nothing is invented afterwards", async () => {
    const calls: string[] = [];
    const api = build(stubSurface(calls));
    await api.experimental.persistentPty.remove({ ptyID: "pty_1" } as never);
    expect(calls).toEqual(["remove:pty_1"]);
  });
});

describe("bridge terminal stream", () => {
  test("without a terminal service the client refuses to open a stream", () => {
    const data = new BridgeData();
    const client = new BridgeClient({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
    });
    expect(() => client.persistentPty.connect({ ptyID: "pty_1", cursor: 0, attachmentID: "att_1" })).toThrow(
      UnsupportedCapability,
    );
  });

  test("an injected terminal service is what the client opens the stream through", async () => {
    const data = new BridgeData();
    const seen: string[] = [];
    const client = new BridgeClient({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      ptyConnect: async (input) => {
        seen.push(input.ptyID + ":" + String(input.cursor) + ":" + input.attachmentID);
        return {
          binaryType: "arraybuffer" as const,
          addEventListener: () => {},
          removeEventListener: () => {},
          send: () => {},
          close: () => {},
        };
      },
    });
    const socket = await client.persistentPty.connect({ ptyID: "pty_1", cursor: 7, attachmentID: "att_1", takeover: true });
    expect(seen).toEqual(["pty_1:7:att_1"]);
    expect(socket.binaryType).toBe("arraybuffer");
  });
});

describe("terminal capability reporting", () => {
  test("without a terminal service the server reports the capability as absent", async () => {
    const api = build();
    const info = (await api.server.info()) as unknown as { capabilities?: { persistentPty?: boolean } };
    expect(info.capabilities?.persistentPty).toBe(false);
  });

  test("with a terminal service the capability is reported as present", async () => {
    const api = build(stubSurface([]));
    const info = (await api.server.info()) as unknown as { capabilities?: { persistentPty?: boolean } };
    expect(info.capabilities?.persistentPty).toBe(true);
  });
});
