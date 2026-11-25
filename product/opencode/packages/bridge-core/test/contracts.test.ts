import { describe, expect, test } from "bun:test";

import {
  ContractError,
  parseApproval,
  parseCapability,
  parseEvent,
  parseSnapshotProvenance,
} from "../src/contracts.ts";

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
  throw new Error("expected a ContractError");
}

const VALID_EVENT = {
  kind: "message.delta",
  sequence: 7,
  sessionId: "ses_abc123",
  messageId: "msg_1",
  payload: "hello",
};

describe("parseEvent", () => {
  test("accepts a well formed streaming event", () => {
    const event = parseEvent(VALID_EVENT);
    expect(event.kind).toBe("message.delta");
    expect(event.sequence).toBe(7);
    expect(event.messageId).toBe("msg_1");
  });

  test("accepts a session event without a message id and reports null", () => {
    const event = parseEvent({ kind: "session.created", sequence: 0, sessionId: "ses_a", payload: "created" });
    expect(event.messageId).toBeNull();
  });

  test("rejects an unknown event variant instead of grouping it", () => {
    expect(failureOf(() => parseEvent({ ...VALID_EVENT, kind: "message.rewound" }))).toBe("UNKNOWN_VARIANT");
  });

  test("rejects a missing required field", () => {
    const { payload, ...rest } = VALID_EVENT;
    expect(failureOf(() => parseEvent(rest))).toBe("MISSING_FIELD");
    expect(payload).toBe("hello");
  });

  test("rejects a negative or fractional sequence", () => {
    expect(failureOf(() => parseEvent({ ...VALID_EVENT, sequence: -1 }))).toBe("INVALID_SEQUENCE");
    expect(failureOf(() => parseEvent({ ...VALID_EVENT, sequence: 1.5 }))).toBe("INVALID_SEQUENCE");
  });

  test("rejects an identifier with unsafe characters", () => {
    expect(failureOf(() => parseEvent({ ...VALID_EVENT, sessionId: "ses/../../etc" }))).toBe("INVALID_IDENTIFIER");
  });

  test("rejects a non object payload", () => {
    expect(failureOf(() => parseEvent([VALID_EVENT]))).toBe("NOT_AN_OBJECT");
  });
});

describe("parseApproval", () => {
  test("accepts the three documented decisions", () => {
    for (const decision of ["allow", "allow_always", "deny"]) {
      expect(parseApproval({ toolCallId: "call_1", decision: decision }).decision).toBe(decision);
    }
  });

  test("rejects an undocumented decision", () => {
    expect(failureOf(() => parseApproval({ toolCallId: "call_1", decision: "maybe" }))).toBe("UNSUPPORTED_VALUE");
  });

  test("normalises an absent reason to null but rejects a non string one", () => {
    expect(parseApproval({ toolCallId: "call_1", decision: "deny" }).reason).toBeNull();
    expect(failureOf(() => parseApproval({ toolCallId: "call_1", decision: "deny", reason: 4 }))).toBe("WRONG_TYPE");
  });
});

describe("parseCapability", () => {
  test("accepts every documented status", () => {
    for (const status of ["unverified", "verified", "degraded", "unsupported", "blocked"]) {
      expect(parseCapability({ id: "session.list", status: status, source: "row:604" }).status).toBe(status);
    }
  });

  test("rejects a status outside the ledger vocabulary", () => {
    expect(failureOf(() => parseCapability({ id: "x", status: "probably-fine", source: "row:1" }))).toBe(
      "UNSUPPORTED_VALUE",
    );
  });
});

describe("parseSnapshotProvenance", () => {
  test("accepts a sha256 provenance record", () => {
    const record = parseSnapshotProvenance({ sourceVersion: "v2.2.7", itemCount: 11416, digest: "a".repeat(64) });
    expect(record.itemCount).toBe(11416);
  });

  test("rejects a digest that is not sha256 hex", () => {
    expect(failureOf(() => parseSnapshotProvenance({ sourceVersion: "v2.2.7", itemCount: 1, digest: "abc" }))).toBe(
      "UNSUPPORTED_VALUE",
    );
  });

  test("rejects a negative item count", () => {
    expect(
      failureOf(() => parseSnapshotProvenance({ sourceVersion: "v2.2.7", itemCount: -3, digest: "b".repeat(64) })),
    ).toBe("UNSUPPORTED_VALUE");
  });
});
