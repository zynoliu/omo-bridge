/**
 * Applies host frames to the low-frequency surfaces.
 *
 * Only two host facts reach these surfaces today: a `wake_source_state` extension event and a
 * `setStatus` entry whose key names the boulder or loop. Everything else stays unavailable, and an
 * unknown or malformed payload is reported as a notice rather than turned into a row.
 */
import { createSignal } from "solid-js"

import type { BridgeData } from "../../../../../bridge-core/src/data.ts"
import { decodeHostExtensionFrame } from "../../../../../bridge-core/src/host-extension-frames.ts"
import { decodeCodeMode, initialOtherState } from "./state.ts"
import type { OtherState } from "./state.ts"

export type OtherStore = {
  readonly state: () => OtherState
  readonly notices: () => readonly string[]
  readonly applyFrame: (raw: unknown) => "applied" | "ignored" | "rejected"
  readonly clearNotices: () => void
}

export function createOtherStore(): OtherStore {
  const [state, setState] = createSignal<OtherState>(initialOtherState())
  const [notices, setNotices] = createSignal<readonly string[]>([])
  const note = (message: string) => setNotices((held) => [...held, message].slice(-20))

  return {
    state: state,
    notices: notices,
    clearNotices: () => setNotices([]),
    applyFrame(raw) {
      const decoded = decodeHostExtensionFrame(raw)
      if (!decoded.ok) return "ignored"
      if (decoded.frame.kind === "extension_event") {
        if (decoded.frame.name !== "wake_source_state") return "ignored"
        const activity = decodeCodeMode(decoded.frame.data)
        if (activity === undefined) {
          note("a wake_source_state event was malformed and was not shown")
          return "rejected"
        }
        setState((held) => ({ ...held, codeMode: { kind: "reported", value: activity } }))
        return "applied"
      }
      if (decoded.frame.kind === "setStatus") {
        const statusText = decoded.frame.statusText
        const key = decoded.frame.statusKey.toLowerCase()
        if (!key.includes("boulder") && !key.includes("loop")) return "ignored"
        if (statusText === undefined) {
          setState((held) => ({
            ...held,
            boulder: { kind: "unavailable", reason: "The host cleared the boulder status entry." },
          }))
          return "applied"
        }
        setState((held) => ({ ...held, boulder: { kind: "reported", value: statusText } }))
        return "applied"
      }
      return "ignored"
    },
  }
}

export function connectBridgeOther(store: OtherStore, data: BridgeData): () => void {
  return data.subscribeEvents((frame) => {
    store.applyFrame(frame)
  })
}
