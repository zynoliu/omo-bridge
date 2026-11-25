import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TransportFailureCode =
  | "LINE_TOO_LONG"
  | "INVALID_UTF8"
  | "UNTERMINATED_FRAME"
  | "AUTH_REJECTED"
  | "AUTH_MATERIAL_MISSING"
  | "STREAM_CLOSED"
  | "NOT_CONNECTED";

export class TransportError extends Error {
  readonly code: TransportFailureCode;
  constructor(code: TransportFailureCode, detail: string) {
    super(code + (detail.length === 0 ? "" : ": " + detail));
    this.name = "TransportError";
    this.code = code;
  }
}

export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class JsonlFrameDecoder {
  readonly maxFrameBytes: number;
  private pending = Buffer.alloc(0);
  private closed = false;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 16) throw new RangeError("maxFrameBytes must be an integer >= 16");
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): readonly string[] {
    if (this.closed) throw new TransportError("STREAM_CLOSED", "decoder already ended");
    if (this.pending.length + chunk.length > this.maxFrameBytes && !Buffer.from(chunk).includes(0x0a)) {
      throw new TransportError("LINE_TOO_LONG", "over " + String(this.maxFrameBytes) + " bytes without a newline");
    }
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const frames: string[] = [];
    for (;;) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) {
        if (this.pending.length > this.maxFrameBytes) {
          throw new TransportError("LINE_TOO_LONG", String(this.pending.length) + " buffered bytes");
        }
        break;
      }
      let line: Buffer = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) continue;
      frames.push(decodeUtf8(line));
    }
    return frames;
  }

  end(): readonly string[] {
    this.closed = true;
    if (this.pending.length === 0) return [];
    const line = this.pending;
    this.pending = Buffer.alloc(0);
    throw new TransportError("UNTERMINATED_FRAME", String(line.length) + " trailing bytes without LF");
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TransportError("INVALID_UTF8", "frame is not valid UTF-8");
  }
}

export function encodeFrame(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TransportError("INVALID_UTF8", "value is not JSON serialisable");
  if (text.includes("\n")) throw new TransportError("INVALID_UTF8", "encoded frame contains a newline");
  return Buffer.from(text + "\n", "utf8");
}

export type ConnectionScope = {
  readonly connectionId: string;
  readonly sessionIds: readonly string[];
};

export type ConnectionState = "new" | "authenticating" | "connected" | "closed";

export type AuthMaterial = {
  readonly secret: Uint8Array;
};

export function loadAuthMaterial(readFile: () => Uint8Array): AuthMaterial {
  const secret = readFile();
  if (secret.length < 16) throw new TransportError("AUTH_MATERIAL_MISSING", "secret material shorter than 16 bytes");
  return { secret: secret };
}

export function challengeResponse(secret: Uint8Array, challenge: string): string {
  if (challenge.length === 0) throw new TransportError("AUTH_REJECTED", "empty challenge");
  return createHash("sha256").update(secret).update(challenge, "utf8").digest("hex");
}

export class AuthGate {
  private state: ConnectionState = "new";
  private readonly material: AuthMaterial;

  constructor(material: AuthMaterial) {
    this.material = material;
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  begin(): string {
    if (this.state !== "new") throw new TransportError("AUTH_REJECTED", "auth already started");
    this.state = "authenticating";
    return createHash("sha256").update(this.material.secret).update("challenge").digest("hex").slice(0, 32);
  }

  verify(challenge: string, received: string): ConnectionScope {
    if (this.state !== "authenticating") throw new TransportError("NOT_CONNECTED", "state " + this.state);
    const expected = Buffer.from(challengeResponse(this.material.secret, challenge), "utf8");
    const actual = Buffer.from(received, "utf8");
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      this.state = "closed";
      throw new TransportError("AUTH_REJECTED", "challenge response mismatch");
    }
    this.state = "connected";
    return { connectionId: "conn_" + challenge.slice(0, 16), sessionIds: [] };
  }

  close(): void {
    this.state = "closed";
  }
}

/**
 * Official senpi RPC socket authentication (rpc.md: socket_auth exchange).
 * The key never crosses the socket; both sides prove possession with HMAC-SHA256.
 */
export type HostKeyRecord = {
  readonly launchId: string;
  readonly key: Uint8Array;
};

const HEX_64 = /^[0-9a-f]{64}$/;

export function parseHostKeyRecord(text: string): HostKeyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransportError("AUTH_MATERIAL_MISSING", "key record is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new TransportError("AUTH_MATERIAL_MISSING", "key record is not an object");
  const record = parsed as { version?: unknown; launch_id?: unknown; key?: unknown };
  if (record.version !== 1) throw new TransportError("AUTH_MATERIAL_MISSING", "unsupported key record version");
  if (typeof record.launch_id !== "string" || record.launch_id.length === 0)
    throw new TransportError("AUTH_MATERIAL_MISSING", "key record lacks a launch id");
  if (typeof record.key !== "string" || !HEX_64.test(record.key))
    throw new TransportError("AUTH_MATERIAL_MISSING", "key record does not hold 64 lowercase hex characters");
  return { launchId: record.launch_id, key: Buffer.from(record.key, "hex") };
}

export function serverProof(record: HostKeyRecord, clientNonce: string, serverNonce: string): Buffer {
  return createHmac("sha256", record.key)
    .update(["senpi-rpc-server", record.launchId, clientNonce, serverNonce].join("\n"), "utf8")
    .digest();
}

export function clientProof(record: HostKeyRecord, clientNonce: string, serverNonce: string): string {
  return createHmac("sha256", record.key)
    .update(["senpi-rpc-client", record.launchId, serverNonce, clientNonce].join("\n"), "utf8")
    .digest("hex");
}

export function verifyServerProof(record: HostKeyRecord, clientNonce: string, serverNonce: string, received: string): void {
  if (!HEX_64.test(received)) throw new TransportError("AUTH_REJECTED", "host_identity_unproven");
  const expected = serverProof(record, clientNonce, serverNonce);
  const actual = Buffer.from(received, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new TransportError("AUTH_REJECTED", "host_identity_unproven");
}
