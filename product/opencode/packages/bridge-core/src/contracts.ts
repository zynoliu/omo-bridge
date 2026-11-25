export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type PartId = Brand<string, "PartId">;
export type ToolCallId = Brand<string, "ToolCallId">;

export type ContractFailureCode =
  | "NOT_AN_OBJECT"
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "UNKNOWN_VARIANT"
  | "INVALID_IDENTIFIER"
  | "INVALID_SEQUENCE"
  | "UNSUPPORTED_VALUE";

export class ContractError extends Error {
  readonly code: ContractFailureCode;
  readonly path: string;
  constructor(code: ContractFailureCode, path: string, detail: string) {
    super(code + " at " + path + (detail.length === 0 ? "" : ": " + detail));
    this.name = "ContractError";
    this.code = code;
    this.path = path;
  }
}

type Fields = Record<string, unknown>;

function asObject(value: unknown, path: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError("NOT_AN_OBJECT", path, typeof value);
  }
  return value as Fields;
}

function required(fields: Fields, key: string, path: string): unknown {
  if (!(key in fields)) throw new ContractError("MISSING_FIELD", path + "." + key, "");
  return fields[key];
}

function requireString(fields: Fields, key: string, path: string): string {
  const value = required(fields, key, path);
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError("WRONG_TYPE", path + "." + key, typeof value);
  }
  return value;
}

function requireNumber(fields: Fields, key: string, path: string): number {
  const value = required(fields, key, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractError("WRONG_TYPE", path + "." + key, typeof value);
  }
  return value;
}

function requireIdentifier<Name extends string>(fields: Fields, key: string, path: string): Brand<string, Name> {
  const value = requireString(fields, key, path);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ContractError("INVALID_IDENTIFIER", path + "." + key, "expected [A-Za-z0-9_-]{1,128}");
  }
  return value as Brand<string, Name>;
}

export const EVENT_KINDS = [
  "session.created",
  "session.updated",
  "message.delta",
  "message.completed",
  "part.updated",
  "tool.started",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "host.error",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type BridgeEvent = {
  readonly kind: EventKind;
  readonly sequence: number;
  readonly sessionId: SessionId;
  readonly messageId: MessageId | null;
  readonly payload: string;
};

const EVENTS_WITHOUT_MESSAGE: readonly EventKind[] = ["session.created", "session.updated", "host.error"];

export function parseEvent(raw: unknown): BridgeEvent {
  const path = "event";
  const fields = asObject(raw, path);
  const kindValue = requireString(fields, "kind", path);
  if (!(EVENT_KINDS as readonly string[]).includes(kindValue)) {
    throw new ContractError("UNKNOWN_VARIANT", path + ".kind", kindValue);
  }
  const kind = kindValue as EventKind;
  const sequence = requireNumber(fields, "sequence", path);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new ContractError("INVALID_SEQUENCE", path + ".sequence", String(sequence));
  }
  const sessionId = requireIdentifier<"SessionId">(fields, "sessionId", path);
  const payload = requireString(fields, "payload", path);

  const messageId =
    EVENTS_WITHOUT_MESSAGE.includes(kind) ? null : requireIdentifier<"MessageId">(fields, "messageId", path);

  return { kind: kind, sequence: sequence, sessionId: sessionId, messageId: messageId, payload: payload };
}

export const APPROVAL_DECISIONS = ["allow", "allow_always", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type Approval = {
  readonly toolCallId: ToolCallId;
  readonly decision: ApprovalDecision;
  readonly reason: string | null;
};

export function parseApproval(raw: unknown): Approval {
  const path = "approval";
  const fields = asObject(raw, path);
  const toolCallId = requireIdentifier<"ToolCallId">(fields, "toolCallId", path);
  const decisionValue = requireString(fields, "decision", path);
  if (!(APPROVAL_DECISIONS as readonly string[]).includes(decisionValue)) {
    throw new ContractError("UNSUPPORTED_VALUE", path + ".decision", decisionValue);
  }
  const reasonValue = fields.reason;
  if (reasonValue !== undefined && reasonValue !== null && typeof reasonValue !== "string") {
    throw new ContractError("WRONG_TYPE", path + ".reason", typeof reasonValue);
  }
  return {
    toolCallId: toolCallId,
    decision: decisionValue as ApprovalDecision,
    reason: typeof reasonValue === "string" ? reasonValue : null,
  };
}

export const CAPABILITY_STATUSES = ["unverified", "verified", "degraded", "unsupported", "blocked"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export type Capability = {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly source: string;
};

export function parseCapability(raw: unknown): Capability {
  const path = "capability";
  const fields = asObject(raw, path);
  const id = requireString(fields, "id", path);
  const statusValue = requireString(fields, "status", path);
  if (!(CAPABILITY_STATUSES as readonly string[]).includes(statusValue)) {
    throw new ContractError("UNSUPPORTED_VALUE", path + ".status", statusValue);
  }
  const source = requireString(fields, "source", path);
  return { id: id, status: statusValue as CapabilityStatus, source: source };
}

export type SnapshotProvenance = {
  readonly sourceVersion: string;
  readonly itemCount: number;
  readonly digest: string;
};

export function parseSnapshotProvenance(raw: unknown): SnapshotProvenance {
  const path = "snapshot";
  const fields = asObject(raw, path);
  const sourceVersion = requireString(fields, "sourceVersion", path);
  const itemCount = requireNumber(fields, "itemCount", path);
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    throw new ContractError("UNSUPPORTED_VALUE", path + ".itemCount", String(itemCount));
  }
  const digest = requireString(fields, "digest", path);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new ContractError("UNSUPPORTED_VALUE", path + ".digest", "expected a sha256 hex digest");
  }
  return { sourceVersion: sourceVersion, itemCount: itemCount, digest: digest };
}
