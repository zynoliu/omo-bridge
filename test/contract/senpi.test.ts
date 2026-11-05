import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownEventType, validateEvent, validateResponse } from "../../src/contract/validate";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "contracts", "senpi");

type Fixture = { frame: Record<string, unknown>; role: string; endpoint: string; source: string; derived?: boolean };

function fixtures(): Fixture[] {
  const records: Fixture[] = [];
  for (const name of readdirSync(FIXTURE_DIR).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(FIXTURE_DIR, name), "utf8").split("\n")) {
      if (line.trim()) records.push(JSON.parse(line) as Fixture);
    }
  }
  return records;
}

const records = fixtures();
const responses = records.filter((record) => record.role === "response");
const events = records.filter((record) => record.role === "event");

describe("senpi contracts", () => {
  test("all six commands were recorded live", () => {
    const commands = responses.map((record) => record.endpoint).sort();
    expect(commands).toEqual(["close_session", "get_entries", "get_protocol_info", "get_state", "list_sessions", "open_session"]);
    for (const record of responses) expect(record.source).toBe("live");
  });

  for (const record of responses) {
    test(`response ${record.endpoint} is accepted`, () => {
      expect(validateResponse(record.endpoint, record.frame)).toEqual({ ok: true });
    });
  }

  for (const record of events) {
    test(`event ${record.endpoint} (${String((record.frame.assistantMessageEvent as { type?: string } | undefined)?.type ?? (record.frame as { method?: string }).method ?? "")}) is accepted`, () => {
      expect(validateEvent(record.endpoint, record.frame)).toEqual({ ok: true });
    });
  }

  test("all nine streaming delta kinds are covered", () => {
    const kinds = new Set(
      events
        .filter((record) => record.endpoint === "message_update")
        .map((record) => (record.frame.assistantMessageEvent as { type: string }).type),
    );
    expect([...kinds].sort()).toEqual([
      "text_delta",
      "text_end",
      "text_start",
      "thinking_delta",
      "thinking_end",
      "thinking_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_start",
    ]);
  });

  test("derived fixtures are marked as such", () => {
    for (const record of events) {
      expect(record.source).toBe("derived");
      expect(record.derived).toBe(true);
    }
  });

  test("unknown event type is rejected by validateEvent and isKnownEventType", () => {
    expect(isKnownEventType("quantum_flux")).toBe(false);
    const result = validateEvent("quantum_flux", { type: "quantum_flux" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("unknown event type");
  });

  test("tampered event type is rejected", () => {
    const update = structuredClone(events.find((record) => record.endpoint === "message_update")!.frame);
    (update.assistantMessageEvent as Record<string, unknown>).type = "telepathy_delta";
    expect(validateEvent("message_update", update).ok).toBe(false);
  });

  test("event frame with a mismatched type field is rejected", () => {
    const queue = structuredClone(events.find((record) => record.endpoint === "queue_update")!.frame);
    queue.type = "agent_start";
    expect(validateEvent("queue_update", queue).ok).toBe(false);
  });

  test("message_update without usage is rejected", () => {
    const update = structuredClone(events.find((record) => record.endpoint === "message_update")!.frame);
    delete update.usage;
    expect(validateEvent("message_update", update).ok).toBe(false);
  });

  test("response with a foreign command is rejected", () => {
    const state = responses.find((record) => record.endpoint === "get_state")!.frame;
    expect(validateResponse("list_sessions", state).ok).toBe(false);
  });

  test("response missing a required data field is rejected", () => {
    const state = structuredClone(responses.find((record) => record.endpoint === "get_state")!.frame);
    delete (state.data as Record<string, unknown>).sessionId;
    expect(validateResponse("get_state", state).ok).toBe(false);
  });

  test("failed response must carry an error string", () => {
    expect(validateResponse("get_state", { type: "response", command: "get_state", success: false }).ok).toBe(false);
    expect(validateResponse("get_state", { type: "response", command: "get_state", success: false, error: "unknown_session" }).ok).toBe(true);
  });
});
