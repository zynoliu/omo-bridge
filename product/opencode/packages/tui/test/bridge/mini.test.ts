import { describe, expect, test } from "bun:test";

import type { SessionInfo } from "@opencode/client";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createMiniBridgeClient } from "../../src/mini/bridge.ts";
import type { MiniBridgeSubmission } from "../../src/mini/bridge.ts";

function sessionInfo(id: string): SessionInfo {
  return {
    id: id,
    projectID: "proj_1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Session " + id,
    location: { directory: "/workspace/" + id },
  };
}

function seam(options: { write?: (submission: MiniBridgeSubmission) => void } = {}) {
  const data = new BridgeData();
  data.upsertHostSession(sessionInfo("sess_1"));
  return createMiniBridgeClient({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace/default" },
    connection: () => "ready",
    write: options.write,
  });
}

describe("mini bridge seam", () => {
  test("the promise client answers the session list from the payloads the host delivered", async () => {
    const mini = seam();
    const page = await mini.sdk.session.list();
    expect(page.data.map((session) => session.id)).toEqual(["sess_1"]);
  });

  test("an entry the host never delivered refuses instead of answering with an empty list", async () => {
    const mini = seam();
    await expect(mini.sdk.session.get({ sessionID: "absent" })).rejects.toBeInstanceOf(UnsupportedCapability);
  });

  test("a prompt without a launcher writer refuses rather than pretending it was sent", () => {
    const mini = seam();
    expect(() => mini.submitPrompt({ sessionID: "sess_1", text: "hello" })).toThrow(UnsupportedCapability);
  });

  test("a prompt with a writer hands the launcher exactly what the caller asked for", () => {
    const seen: MiniBridgeSubmission[] = [];
    const mini = seam({ write: (submission) => seen.push(submission) });
    const submission = mini.submitPrompt({ sessionID: "sess_1", text: "hello" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(submission);
    expect(submission.text).toBe("hello");
    expect(submission.sessionID).toBe("sess_1");
  });

  test("abort reports that there was no active turn instead of claiming one ended", () => {
    const mini = seam();
    expect(mini.abort("sess_1")).toBe(false);
  });

  test("the connection state comes from the launcher, not from an HTTP handshake", () => {
    const mini = seam();
    expect(mini.state().connection).toBe("ready");
  });
});
