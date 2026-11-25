export * as AgentCustomEvent from "./agent-custom-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { Location } from "./location.js"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

/**
 * One event per extension name, `agent.custom.<name>`: the host publishes extension records as
 * `extension_event {type, name, data, sessionId?}`, so the name is dynamic by construction.
 *
 * A `Definition` cannot carry a templated `type` -- `Event.latest` keys its map by the literal type and
 * the generated unions enumerate literals -- so this schema is appended explicitly by
 * `EventManifest.TemplatedDefinitions`, the protocol event group and the bridge's host-event decoder,
 * and `EventManifest.isServer` recognises it by prefix.
 */
export const PREFIX = "agent.custom."

export const isType = (type: string): boolean => type.startsWith(PREFIX)

/**
 * `sessionId` is the routing id the host named and is not a client `SessionID`; `sessionID` is that id
 * resolved to the client session, absent when no session is known. `name` repeats the type's suffix.
 */
export const Data = Schema.Struct({
  name: Schema.String,
  sessionId: optional(Schema.String),
  sessionID: optional(SessionID),
  payload: Schema.Unknown,
}).annotate({ identifier: "Agent.Custom.Data" })
export type Data = typeof Data.Type

export const Definition = Schema.Struct({
  id: Event.ID,
  created: Schema.Finite,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  type: Schema.TemplateLiteral([PREFIX, Schema.String]),
  location: optional(Location.Ref),
  data: Data,
}).annotate({ identifier: "agent.custom" })
export type Definition = typeof Definition.Type
