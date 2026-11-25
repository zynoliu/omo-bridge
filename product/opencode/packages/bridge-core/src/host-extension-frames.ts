/**
 * Decoders for the host frames the TUI needs but `host-frames.ts` deliberately rejects.
 *
 * Three shapes are decoded here, each derived from the upstream source named beside it:
 *
 * - `extension_event` - `{ type, name, data }`
 *   (upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-session-event-types.ts:10-14);
 * - fire-and-forget `extension_ui_request` methods `notify`, `setStatus`, `setWidget`,
 *   `setSubagentCost`, `setTitle`, `set_editor_text` and `custom_unsupported`
 *   (upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-question-types.ts:92-131);
 * - `custom_message` session entries `{ type, id, parentId?, timestamp?, customType, content, details?, display }`
 *   (upstream/senpi/packages/coding-agent/src/core/session-manager.ts:398-404 plus the shared entry base).
 *
 * Every decoder checks each field it reads and rejects the frame with a reason instead of coercing
 * it. An unknown method or type is never guessed at, and nothing here throws.
 */
export type HostExtensionEvent = {
  readonly kind: "extension_event"
  readonly name: string
  readonly data: unknown
  readonly sessionId?: string
}

export type HostNotifyRequest = {
  readonly kind: "notify"
  readonly message: string
  readonly notifyType: "info" | "warning" | "error" | undefined
}

export type HostStatusRequest = {
  readonly kind: "setStatus"
  readonly statusKey: string
  readonly statusText: string | undefined
}

export type HostWidgetRequest = {
  readonly kind: "setWidget"
  readonly widgetKey: string
  readonly widgetLines: readonly string[] | undefined
  readonly widgetPlacement: "aboveEditor" | "belowEditor" | undefined
  readonly widgetActions: readonly { readonly label: string; readonly command: string }[] | undefined
}

export type HostPlainRequest = {
  readonly kind: "setSubagentCost" | "setTitle" | "setEditorText" | "customUnsupported"
  readonly text: string | undefined
  readonly cost: number | undefined
}

export type HostCustomMessage = {
  readonly kind: "custom_message"
  readonly id: string
  readonly parentId: string | undefined
  readonly customType: string
  readonly content: unknown
  readonly details: unknown
  readonly display: boolean
}

export type HostExtensionFrame =
  | HostExtensionEvent
  | HostNotifyRequest
  | HostStatusRequest
  | HostWidgetRequest
  | HostPlainRequest
  | HostCustomMessage

export type HostExtensionDecoded = { readonly ok: true; readonly frame: HostExtensionFrame }
export type HostExtensionRejected = { readonly ok: false; readonly reason: string }
export type HostExtensionResult = HostExtensionDecoded | HostExtensionRejected

/** Reads one own-or-inherited property without asserting the object's shape. */
function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function rejected(reason: string): HostExtensionRejected {
  return { ok: false, reason: reason }
}

export function decodeHostExtensionFrame(frame: unknown): HostExtensionResult {
  if (typeof frame !== "object" || frame === null) return rejected("frame is not an object")
  const type = text(field(frame, "type"))
  if (type === undefined) return rejected("frame has no string type")

  if (type === "extension_event") {
    const name = text(field(frame, "name"))
    if (name === undefined) return rejected("extension_event has no string name")
    return { ok: true, frame: { kind: "extension_event", name: name, data: field(frame, "data"), sessionId: text(field(frame, "sessionId")) } }
  }

  if (type === "custom_message") {
    const id = text(field(frame, "id"))
    const customType = text(field(frame, "customType"))
    if (id === undefined) return rejected("custom_message has no string id")
    if (customType === undefined) return rejected("custom_message has no string customType")
    const display = field(frame, "display")
    if (typeof display !== "boolean") return rejected("custom_message has no boolean display")
    return {
      ok: true,
      frame: {
        kind: "custom_message",
        id: id,
        parentId: text(field(frame, "parentId")),
        customType: customType,
        content: field(frame, "content"),
        details: field(frame, "details"),
        display: display,
      },
    }
  }

  if (type !== "extension_ui_request") return rejected("unknown frame type: " + type)

  const method = text(field(frame, "method"))
  if (method === "notify") {
    const message = text(field(frame, "message"))
    if (message === undefined) return rejected("notify has no string message")
    const level = text(field(frame, "notifyType"))
    if (level !== undefined && level !== "info" && level !== "warning" && level !== "error")
      return rejected("notify has an unknown notifyType: " + level)
    return { ok: true, frame: { kind: "notify", message: message, notifyType: level } }
  }

  if (method === "setStatus") {
    const statusKey = text(field(frame, "statusKey"))
    if (statusKey === undefined) return rejected("setStatus has no string statusKey")
    const statusText = field(frame, "statusText") === undefined ? undefined : text(field(frame, "statusText"))
    if (field(frame, "statusText") !== undefined && statusText === undefined) return rejected("setStatus statusText is not a string")
    return { ok: true, frame: { kind: "setStatus", statusKey: statusKey, statusText: statusText } }
  }

  if (method === "setWidget") {
    const widgetKey = text(field(frame, "widgetKey"))
    if (widgetKey === undefined) return rejected("setWidget has no string widgetKey")
    const lines = unionOfStrings(field(frame, "widgetLines"))
    if (lines === "invalid") return rejected("setWidget widgetLines is not a string array or undefined")
    const placement = text(field(frame, "widgetPlacement"))
    if (placement !== undefined && placement !== "aboveEditor" && placement !== "belowEditor")
      return rejected("setWidget has an unknown widgetPlacement: " + placement)
    const actions = widgetActions(field(frame, "widgetActions"))
    if (actions === "invalid") return rejected("setWidget widgetActions is not a list of label/command pairs")
    return {
      ok: true,
      frame: { kind: "setWidget", widgetKey: widgetKey, widgetLines: lines, widgetPlacement: placement, widgetActions: actions },
    }
  }

  if (method === "setTitle") {
    const title = text(field(frame, "title"))
    if (title === undefined) return rejected("setTitle has no string title")
    return { ok: true, frame: { kind: "setTitle", text: title, cost: undefined } }
  }

  if (method === "set_editor_text") {
    const value = text(field(frame, "text"))
    if (value === undefined) return rejected("set_editor_text has no string text")
    return { ok: true, frame: { kind: "setEditorText", text: value, cost: undefined } }
  }

  if (method === "setSubagentCost") {
    const cost = field(frame, "costUsd")
    if (cost !== undefined && typeof cost !== "number") return rejected("setSubagentCost costUsd is not a number")
    return { ok: true, frame: { kind: "setSubagentCost", text: undefined, cost: typeof cost === "number" ? cost : undefined } }
  }

  if (method === "custom_unsupported") {
    const name = text(field(frame, "extensionName"))
    if (name === undefined) return rejected("custom_unsupported has no string extensionName")
    return { ok: true, frame: { kind: "customUnsupported", text: name, cost: undefined } }
  }

  return rejected("extension_ui_request method not decoded: " + String(field(frame, "method")))
}

function unionOfStrings(value: unknown): readonly string[] | undefined | "invalid" {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return "invalid"
  for (const item of value) if (typeof item !== "string") return "invalid"
  return value
}

function widgetActions(value: unknown): readonly { readonly label: string; readonly command: string }[] | undefined | "invalid" {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return "invalid"
  const actions: { label: string; command: string }[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) return "invalid"
    const label = text(field(item, "label"))
    const command = text(field(item, "command"))
    if (label === undefined || command === undefined) return "invalid"
    actions.push({ label: label, command: command })
  }
  return actions
}
