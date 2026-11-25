import { describe, expect, test } from "bun:test";

import { BridgeIdScheme, ascendingIdentifier } from "../src/id-scheme.ts";

const HOST_ENTRY = "78160a07";
const TIMESTAMP = 1_700_000_000_000;

describe("minted message ids", () => {
  test("a message id has the client's msg_ shape and length", () => {
    const scheme = new BridgeIdScheme();
    const id = scheme.messageID({ sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 }, TIMESTAMP);
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(id.length).toBe(30);
  });

  test("the same host entry mints the same id on every pull and in every process", () => {
    const identity = { sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 };
    const first = new BridgeIdScheme().messageID(identity, TIMESTAMP);
    const second = new BridgeIdScheme();
    expect(second.messageID(identity, TIMESTAMP)).toBe(first);
    expect(second.messageID(identity, TIMESTAMP)).toBe(first);
  });

  test("different host entries never share an id, bound or positional", () => {
    const scheme = new BridgeIdScheme();
    const bound = scheme.messageID({ sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 }, TIMESTAMP);
    const otherEntry = scheme.messageID({ sessionID: "ses_1", entryID: "19280c59", ordinal: 1 }, TIMESTAMP);
    const unboundFirst = scheme.messageID({ sessionID: "ses_1", ordinal: 0 }, TIMESTAMP);
    const unboundSecond = scheme.messageID({ sessionID: "ses_1", ordinal: 1 }, TIMESTAMP);
    expect(new Set([bound, otherEntry, unboundFirst, unboundSecond]).size).toBe(4);
  });

  test("ids keep the host's time order, like the client's ascending identifiers", () => {
    const scheme = new BridgeIdScheme();
    const earlier = scheme.messageID({ sessionID: "ses_1", entryID: "aaaa1111", ordinal: 0 }, TIMESTAMP);
    const later = scheme.messageID({ sessionID: "ses_1", entryID: "bbbb2222", ordinal: 1 }, TIMESTAMP + 1_000);
    expect(earlier < later).toBe(true);
  });

  test("the map answers the host entry from the minted id and back", () => {
    const scheme = new BridgeIdScheme();
    const identity = { sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 };
    const id = scheme.messageID(identity, TIMESTAMP);
    expect(scheme.hostOf(id)).toEqual({ kind: "message", ...identity });
    expect(scheme.idForMessage(identity)).toBe(id);
    expect(scheme.hostOf("msg_unknown")).toBeUndefined();
  });
});

describe("live message identities", () => {
  test("a host message id the client already brands is kept, not re-minted", () => {
    const scheme = new BridgeIdScheme();
    expect(scheme.hostMessageID("ses_1", "msg_01a20e7a1c9eRS4pBoubKS98O7", TIMESTAMP)).toBe("msg_01a20e7a1c9eRS4pBoubKS98O7");
  });

  test("a host message id outside the client scheme mints a client id, stably", () => {
    const scheme = new BridgeIdScheme();
    const id = scheme.hostMessageID("ses_1", "fe2f5817", TIMESTAMP);
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(new BridgeIdScheme().hostMessageID("ses_1", "fe2f5817", TIMESTAMP)).toBe(id);
    expect(scheme.hostMessageID("ses_1", "4cdef1a4", TIMESTAMP)).not.toBe(id);
  });

  test("a message the host has not named yet mints a distinct client id per ordinal", () => {
    const scheme = new BridgeIdScheme();
    const first = scheme.streamMessageID("ses_1", 1, TIMESTAMP);
    const second = scheme.streamMessageID("ses_1", 2, TIMESTAMP);
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(new Set([first, second]).size).toBe(2);
    expect(new BridgeIdScheme().streamMessageID("ses_1", 1, TIMESTAMP)).toBe(first);
    expect(scheme.streamMessageID("ses_2", 1, TIMESTAMP)).not.toBe(first);
  });

  test("the three bases never mint one id for the same session", () => {
    const scheme = new BridgeIdScheme();
    const ids = new Set([
      scheme.messageID({ sessionID: "ses_1", entryID: HOST_ENTRY }, TIMESTAMP),
      scheme.messageID({ sessionID: "ses_1", ordinal: 0 }, TIMESTAMP),
      scheme.hostMessageID("ses_1", "0", TIMESTAMP),
      scheme.streamMessageID("ses_1", 0, TIMESTAMP),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("minted part ids", () => {
  test("a part id has the client's part_ shape and is stable for the same part", () => {
    const scheme = new BridgeIdScheme();
    const message = scheme.messageID({ sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 }, TIMESTAMP);
    const text = scheme.partID(message, { kind: "text", ordinal: 0 }, TIMESTAMP);
    expect(text).toMatch(/^part_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(new BridgeIdScheme().partID(message, { kind: "text", ordinal: 0 }, TIMESTAMP)).toBe(text);
  });

  test("parts of one message are distinct per part", () => {
    const scheme = new BridgeIdScheme();
    const message = scheme.messageID({ sessionID: "ses_1", entryID: HOST_ENTRY, ordinal: 0 }, TIMESTAMP);
    const ids = [
      scheme.partID(message, { kind: "text", ordinal: 0 }, TIMESTAMP),
      scheme.partID(message, { kind: "text", ordinal: 1 }, TIMESTAMP),
      scheme.partID(message, { kind: "reasoning", ordinal: 0 }, TIMESTAMP),
      scheme.partID(message, { kind: "tool", ordinal: 2 }, TIMESTAMP),
    ];
    expect(new Set(ids).size).toBe(4);
    expect(new Set(ids.map((id) => scheme.hostOf(id)?.kind))).toEqual(new Set(["part"]));
  });

  test("ascendingIdentifier keeps the prefix and the 26-character client tail", () => {
    const id = ascendingIdentifier("evt_", TIMESTAMP, "identity");
    expect(id).toMatch(/^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(ascendingIdentifier("evt_", TIMESTAMP, "identity")).toBe(id);
    expect(ascendingIdentifier("evt_", TIMESTAMP, "other")).not.toBe(id);
  });
});
