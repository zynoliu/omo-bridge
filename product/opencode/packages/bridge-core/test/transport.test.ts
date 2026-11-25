import { describe, expect, test } from "bun:test";

import {
  AuthGate,
  JsonlFrameDecoder,
  TransportError,
  challengeResponse,
  encodeFrame,
  loadAuthMaterial,
  parseHostKeyRecord,
  serverProof,
  clientProof,
  verifyServerProof,
} from "../src/transport.ts";
import { createHmac } from "node:crypto";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    throw error;
  }
  throw new Error("expected a TransportError");
}

const SECRET = new Uint8Array(32).fill(7);

describe("JsonlFrameDecoder", () => {
  test("splits two LF terminated frames", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles a frame split across chunk boundaries", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(Buffer.from('{"a":'))).toEqual([]);
    expect(decoder.push(Buffer.from("1}"))).toEqual([]);
    expect(decoder.push(Buffer.from("\n"))).toEqual(['{"a":1}']);
  });

  test("reassembles a multi byte character split across chunks", () => {
    const frame = Buffer.from(JSON.stringify({ text: "中文" }) + "\n", "utf8");
    const cut = frame.indexOf(Buffer.from("中", "utf8")) + 1;
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(frame.subarray(0, cut))).toEqual([]);
    const frames = decoder.push(frame.subarray(cut));
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0] ?? "{}")).toEqual({ text: "中文" });
  });

  test("accepts CRLF and strips the carriage return", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  test("skips empty lines instead of emitting empty frames", () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push(Buffer.from('\n\n{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  test("reports an over long frame instead of buffering it forever", () => {
    const decoder = new JsonlFrameDecoder(32);
    expect(codeOf(() => decoder.push(Buffer.alloc(64, 0x61)))).toBe("LINE_TOO_LONG");
  });

  test("reports invalid UTF-8 rather than replacing bytes", () => {
    const decoder = new JsonlFrameDecoder();
    expect(codeOf(() => decoder.push(Buffer.from([0xff, 0xfe, 0x0a])))).toBe("INVALID_UTF8");
  });

  test("reports trailing bytes at EOF", () => {
    const decoder = new JsonlFrameDecoder();
    decoder.push(Buffer.from('{"a":1}'));
    expect(codeOf(() => decoder.end())).toBe("UNTERMINATED_FRAME");
  });

  test("refuses input after end", () => {
    const decoder = new JsonlFrameDecoder();
    decoder.end();
    expect(codeOf(() => decoder.push(Buffer.from("x\n")))).toBe("STREAM_CLOSED");
  });
});

describe("encodeFrame", () => {
  test("round trips through the decoder", () => {
    const decoder = new JsonlFrameDecoder();
    const frames = decoder.push(encodeFrame({ hello: "world" }));
    expect(JSON.parse(frames[0] ?? "{}")).toEqual({ hello: "world" });
  });
});

describe("AuthGate", () => {
  test("moves to connected only for the correct challenge response", () => {
    const gate = new AuthGate(loadAuthMaterial(() => SECRET));
    const challenge = gate.begin();
    expect(gate.currentState).toBe("authenticating");
    const scope = gate.verify(challenge, challengeResponse(SECRET, challenge));
    expect(gate.currentState).toBe("connected");
    expect(scope.connectionId.startsWith("conn_")).toBe(true);
    expect(scope.sessionIds).toEqual([]);
  });

  test("stays out of the connected state for a wrong response", () => {
    const gate = new AuthGate(loadAuthMaterial(() => SECRET));
    const challenge = gate.begin();
    expect(codeOf(() => gate.verify(challenge, challengeResponse(new Uint8Array(32).fill(9), challenge)))).toBe(
      "AUTH_REJECTED",
    );
    expect(gate.currentState).toBe("closed");
    expect(codeOf(() => gate.verify(challenge, challengeResponse(SECRET, challenge)))).toBe("NOT_CONNECTED");
  });

  test("rejects short auth material without reading anything else", () => {
    expect(codeOf(() => loadAuthMaterial(() => new Uint8Array(4)))).toBe("AUTH_MATERIAL_MISSING");
  });
});
describe("official socket authentication", () => {
  const key = "f".repeat(63) + "0";
  const record = { version: 1, launch_id: "launch_1", key: key };

  test("parses the published key record and rejects unsafe shapes", () => {
    const parsed = parseHostKeyRecord(JSON.stringify(record));
    expect(parsed.launchId).toBe("launch_1");
    expect(parsed.key.length).toBe(32);
    expect(codeOf(() => parseHostKeyRecord("{not json"))).toBe("AUTH_MATERIAL_MISSING");
    expect(codeOf(() => parseHostKeyRecord(JSON.stringify({ ...record, version: 2 })))).toBe("AUTH_MATERIAL_MISSING");
    expect(codeOf(() => parseHostKeyRecord(JSON.stringify({ ...record, key: "F".repeat(64) })))).toBe("AUTH_MATERIAL_MISSING");
    expect(codeOf(() => parseHostKeyRecord(JSON.stringify({ ...record, key: "abc" })))).toBe("AUTH_MATERIAL_MISSING");
    expect(codeOf(() => parseHostKeyRecord(JSON.stringify({ ...record, launch_id: "" })))).toBe("AUTH_MATERIAL_MISSING");
  });

  test("the server and client proofs use the documented labels and nonce order", () => {
    const parsed = parseHostKeyRecord(JSON.stringify(record));
    const expectedServer = createHmac("sha256", Buffer.from(key, "hex"))
      .update(["senpi-rpc-server", "launch_1", "aa", "bb"].join("\n"), "utf8")
      .digest();
    const expectedClient = createHmac("sha256", Buffer.from(key, "hex"))
      .update(["senpi-rpc-client", "launch_1", "bb", "aa"].join("\n"), "utf8")
      .digest("hex");
    expect(serverProof(parsed, "aa", "bb").equals(expectedServer)).toBe(true);
    expect(clientProof(parsed, "aa", "bb")).toBe(expectedClient);
    expect(clientProof(parsed, "aa", "bb")).not.toBe(serverProof(parsed, "aa", "bb").toString("hex"));
  });

  test("a proof for the wrong role, wrong nonces, or malformed hex is rejected", () => {
    const parsed = parseHostKeyRecord(JSON.stringify(record));
    const good = serverProof(parsed, "aa", "bb").toString("hex");
    verifyServerProof(parsed, "aa", "bb", good);
    expect(codeOf(() => verifyServerProof(parsed, "aa", "bb", clientProof(parsed, "aa", "bb")))).toBe("AUTH_REJECTED");
    expect(codeOf(() => verifyServerProof(parsed, "ab", "bb", good))).toBe("AUTH_REJECTED");
    expect(codeOf(() => verifyServerProof(parsed, "aa", "bb", good.toUpperCase()))).toBe("AUTH_REJECTED");
    expect(codeOf(() => verifyServerProof(parsed, "aa", "bb", "zz"))).toBe("AUTH_REJECTED");
  });
});
