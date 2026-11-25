import { Option, Result, Schema, SchemaIssue, SchemaParser } from "../../schema/node_modules/effect/dist/index.js";
import { EventManifest } from "../../schema/src/event-manifest.ts";
import type { BridgeData } from "./data.ts";

/**
 * Every event the host publishes, validated on its encoded side against the same definitions
 * `packages/protocol/src/groups/event.ts` turns into the `/api/event` payload schema, plus the templated
 * `agent.custom.<name>` member that stream schema appends beside its literal definitions. The encoded
 * projection is the wire shape, so a valid frame is handed out exactly as received.
 *
 * Note: this is deliberately the schema's own event type, not `OpenCodeEvent`. The client's
 * generated `V2Event` requires `durable.version` to be a literal, which neither this projection
 * nor `Event.durable`'s statics carry at the type level, so it cannot be reached without an assertion.
 */
const HostEventSchema = Schema.toEncoded(
  Schema.Union([...EventManifest.ServerDefinitions, ...EventManifest.TemplatedDefinitions]),
);

export type HostEventFrame = Schema.Schema.Type<typeof HostEventSchema>;

const readFrameType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

const decodeHostEventValue = SchemaParser.decodeUnknownResult(HostEventSchema);
const formatIssue = SchemaIssue.makeFormatterDefault();

export type HostEventDecoded = { readonly ok: true; readonly event: HostEventFrame };
export type HostEventRejected = { readonly ok: false; readonly reason: string };
export type HostEventDecodeResult = HostEventDecoded | HostEventRejected;

/**
 * Validates one host JSONL frame. An unknown type, a missing field or a field of the wrong kind
 * is rejected with a reason rather than coerced, and an unknown type never throws.
 */
export function decodeHostEvent(frame: unknown): HostEventDecodeResult {
  const typed = readFrameType(frame);
  if (Option.isNone(typed)) return { ok: false, reason: "event frame has no string type" };
  if (!EventManifest.isServer(typed.value))
    return { ok: false, reason: "unknown event type: " + typed.value.type };
  const decoded = decodeHostEventValue(frame);
  if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
  return { ok: true, event: decoded.success };
}

export function matchesEventType<Type extends HostEventFrame["type"]>(
  event: HostEventFrame,
  type: Type,
): event is Extract<HostEventFrame, { type: Type }> {
  return event.type === type;
}

/**
 * Projects the permission lifecycle the host actually publishes into the bridge store.
 * Returns true when the frame was a permission event this function owns.
 */
export function applyPermissionEvent(data: BridgeData, event: HostEventFrame): boolean {
  if (event.type === "permission.asked") {
    data.upsertPermission({
      id: event.data.id,
      sessionID: event.data.sessionID,
      action: event.data.action,
      resources: [...event.data.resources],
      save: event.data.save === undefined ? undefined : [...event.data.save],
      /* the schema leaves metadata unconstrained, so it is not carried into the client typed request */
      source: event.data.source,
      message: event.data.message,
    });
    return true;
  }
  if (event.type === "permission.replied") {
    data.resolvePermission(event.data.requestID);
    return true;
  }
  return false;
}

/** Projects the form lifecycle the host publishes. Returns true when the frame was a form event. */
export function applyFormEvent(data: BridgeData, event: HostEventFrame): boolean {
  if (event.type === "form.created") {
    /* The host's form metadata is a plain record; the client's FormMetadata is that same record with a
       JsonValue index signature, and every field the render path reads is a string or a list of them. */
    data.upsertForm(event.data.form as unknown as Parameters<BridgeData["upsertForm"]>[0]);
    return true;
  }
  if (event.type === "form.replied" || event.type === "form.cancelled") {
    data.resolveForm(event.data.id);
    return true;
  }
  return false;
}
