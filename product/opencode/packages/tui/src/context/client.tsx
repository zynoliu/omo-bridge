import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { createClientConnection, createPersistentPtyClient } from "@opencode/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import type { Plugin } from "@opencode/plugin/tui"
import { createMediaCache } from "../util/media"
import { useLog } from "./log"

type ManagedService = {
  reconnect: (signal: AbortSignal) => Promise<{ api: OpenCodeClient; url?: string; headers?: Record<string, string> }>
  restart: () => Promise<void>
}

type ClientEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

/**
 * The live stream the terminal pane reads and writes. The HTTP client dials it as a websocket; a launcher
 * that owns the terminal service itself hands one over already connected, so the pane's contract is the
 * only thing this shape has to satisfy.
 */
export type BridgePtyConnector = {
  readonly connect: (input: {
    readonly ptyID: string
    readonly cursor: number
    readonly attachmentID: string
    readonly takeover?: boolean
  }) => Promise<unknown>
}

type PtyConnector = {
  readonly connect: (input: {
    readonly ptyID: string
    readonly cursor: number
    readonly attachmentID: string
    readonly takeover?: boolean
  }) => Promise<WebSocket>
}

export const {
  use: useClient,
  provider: ClientProvider,
  context: ClientContext,
} = createSimpleContext({
  name: "Client",
  init: (props: {
    api: OpenCodeClient
    url?: string
    headers?: Record<string, string>
    service?: ManagedService
    /** Set by the launcher when it serves terminals in-process; absent in HTTP mode. */
    bridgePty?: BridgePtyConnector
    bridge?: {
      readonly connectionState: () => string
      readonly usesInProcessAdapter: true
      readonly startsHttpService: false
      readonly dataContext?: Plugin.Context["data"]
    }
  }) => {
    const log = useLog({ component: "client" })
    const service = props.service
    const events = createGlobalEmitter<ClientEventMap>()
    let api = props.api
    let url = props.url
    let headers = props.headers
    let persistentPty: PtyConnector | undefined = props.bridgePty
      ? {
          connect: async (input) => (await props.bridgePty!.connect(input)) as WebSocket,
        }
      : url
        ? (createPersistentPtyClient(api, { url }) as unknown as PtyConnector)
        : undefined
    const media = createMediaCache(() => api)

    const connection = createClientConnection(api, {
      reconnect: service
        ? async (signal) => {
            const next = await service.reconnect(signal)
            api = next.api
            if (next.url) url = next.url
            headers = next.headers
            if (url && props.bridgePty === undefined) persistentPty = createPersistentPtyClient(api, { url }) as unknown as PtyConnector
            return api
          }
        : undefined,
      onEvent(event) {
        events.emit(event.type, event)
      },
      log,
    })

    onCleanup(() => {
      events.clear()
    })

    return {
      get api() {
        return api
      },
      get url() {
        return url
      },
      get headers() {
        return headers
      },
      get persistentPty() {
        if (!persistentPty) throw new Error("Persistent terminal server endpoint is unavailable")
        return persistentPty
      },
      event: {
        on: events.on,
        listen: events.listen,
      },
      connection,
      media,
      bridge: props.bridge,
      restart: service?.restart,
    }
  },
})
