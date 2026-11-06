// Shared wire types for the senpi -> opencode translation layer.
//
// Every event the SSE endpoint serves goes through `OpenCodeEvent`: the envelope the TUI's data
// layer switches on. Per-event payload shapes belong to the translator that emits them.

/** The opencode event envelope served over `/api/event` (`packages/schema/src/event.ts`). */
export type OpenCodeEvent = {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
  location?: { directory: string; workspaceID?: string };
};

/** Where translated events go; the SSE event bus's `publish` satisfies it. */
export type EventSink = (event: OpenCodeEvent) => void;

/**
 * The id an in-flight assistant step streams under, and the provisional-to-durable id map.
 *
 * Mutable by design: the runtime sets `live` when it mints a provisional id, and the stream
 * projector clears it and records the alias when the durable entry lands. The tool and lifecycle
 * projectors read the same map, so a step that started under a provisional id keeps one row.
 */
export type MessageIdentity = {
  live: string | undefined;
  aliases: Map<string, string>;
};

/** Per-session identity and clock a translator uses to mint event envelopes. */
export type TranslateContext = {
  sessionID: string;
  nextID: () => string;
  now: () => number;
  /** Absent in unit tests that build a context by hand; the runtime always supplies one. */
  identity?: MessageIdentity;
};
