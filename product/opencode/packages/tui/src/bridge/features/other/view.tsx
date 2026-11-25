import { For, Show, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"

import { useTheme } from "../../../context/theme"
import type { OtherStore } from "./store.ts"

/**
 * Draws the low-frequency surfaces. A surface the host never publishes says so in one line instead of
 * holding an empty box, so a reader can tell "nothing happened" from "not available here".
 */
export function Other(props: { readonly store: OtherStore }) {
  const theme = useTheme()
  const codeMode = createMemo(() => {
    const surface = props.store.state().codeMode
    return surface.kind === "reported" ? surface.value : undefined
  })
  const codeReason = createMemo(() => {
    const surface = props.store.state().codeMode
    return surface.kind === "unavailable" ? surface.reason : ""
  })
  const boulder = createMemo(() => {
    const surface = props.store.state().boulder
    return surface.kind === "reported" ? surface.value : undefined
  })
  const boulderReason = createMemo(() => {
    const surface = props.store.state().boulder
    return surface.kind === "unavailable" ? surface.reason : ""
  })
  return (
    <box flexDirection="column">
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>CodeMode</text>
      <Show when={codeMode()} fallback={<text fg={theme.text.muted}>{codeReason()}</text>}>
        {(activity) => (
          <box flexDirection="column">
            <text fg={theme.text.muted}>{activity().source + "  active " + String(activity().activeCount)}</text>
            <For each={activity().items}>
              {(item) => <text fg={theme.text.muted}>{"  " + item.description}</text>}
            </For>
          </box>
        )}
      </Show>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Boulder</text>
      <Show when={boulder()} fallback={<text fg={theme.text.muted}>{boulderReason()}</text>}>
        {(value) => <text fg={theme.text.muted}>{value()}</text>}
      </Show>
      <Show when={props.store.notices().length > 0}>
        <text fg={theme.text.muted}>{"rejected frames: " + String(props.store.notices().length)}</text>
      </Show>
    </box>
  )
}
