import type { OpenCodeClient } from "@opencode/client";

import type { BridgeData } from "../../../bridge-core/src/data.ts";
import { createEventSurface } from "../../../bridge-core/src/event-surface.ts";
import { createBridgeOpencodeApi } from "../../../bridge-core/src/opencode-api.ts";
import { createSessionSurface } from "../../../bridge-core/src/opencode-surface.ts";
import { createPartSurface } from "../../../bridge-core/src/part-surface.ts";

/** The real bridge client event stream the TUI's client connection also reads, not a test double. */
export function bridgeEvents(data: BridgeData): OpenCodeClient["event"] {
  return createBridgeOpencodeApi({
    data: data,
    defaultLocation: { directory: "/workspace" },
    events: createEventSurface(),
    sessions: createSessionSurface(data),
    parts: createPartSurface(data),
  }).event;
}
