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

/** Per-session identity and clock a translator uses to mint event envelopes. */
export type TranslateContext = {
  sessionID: string;
  nextID: () => string;
  now: () => number;
};
