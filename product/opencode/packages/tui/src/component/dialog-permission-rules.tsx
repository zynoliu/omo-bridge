import { For, Show, createMemo } from "solid-js"

import type { PermissionRule, PermissionRuleset } from "../../../bridge-core/src/permission-rules.ts"
import { bridgeAdapters, bridgeStores } from "../context/bridge-data"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"

/**
 * The rules the bridge keeps, read-only.
 *
 * The host publishes an approval preset, not a rule document, so this list is bridge state: it is what
 * `SessionInfo.permissions` carries and what answers a host dialog before a person sees it. With a
 * session id it shows that session; without one it shows every session the document holds, because none
 * of them can be reached from the home screen. Nothing here edits the document.
 */
export function DialogPermissionRules(props: { sessionID: string }) {
  const data = useData()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const adapter = bridgeAdapters.get(data)
  const store = bridgeStores.get(data)
  const groups = createMemo(() => {
    if (props.sessionID.length > 0) {
      const rules: PermissionRuleset = adapter?.session.permission.rules(props.sessionID) ?? []
      return [{ sessionID: props.sessionID, rules: rules }]
    }
    if (store === undefined) return []
    return store
      .sessionPermissionRuleSessions()
      .map((sessionID) => ({ sessionID: sessionID, rules: store.sessionPermissionRulesFor(sessionID) }))
      .filter((group) => group.rules.length > 0)
  })
  const total = createMemo(() => groups().reduce((count, group) => count + group.rules.length, 0))
  const effectColor = (effect: PermissionRule["effect"]) => {
    if (effect === "deny") return theme.text.feedback.error.base
    if (effect === "allow") return theme.text.feedback.success.base
    return theme.text.feedback.warning.base
  }

  dialog.setCentered(true)

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "escape", title: "Close", group: "Dialog", run: () => dialog.clear() },
      { bind: "return", title: "Close", group: "Dialog", run: () => dialog.clear() },
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title="Permission rules" description="Session rules the bridge enforces before the dialog" />}
      footer={{ actions: { primary: [{ title: "close", key: "esc", onTrigger: () => dialog.clear() }] } }}
    >
      <Show
        when={total() > 0}
        fallback={<text fg={theme.text.muted}>No session rules are configured: every ask opens the host's dialog.</text>}
      >
        <box flexDirection="column" gap={1}>
          <For each={groups()}>
            {(group) => (
              <box flexDirection="column">
                <text fg={theme.text.muted}>
                  {group.rules.length} rule{group.rules.length === 1 ? "" : "s"} for {group.sessionID}
                </text>
                <For each={group.rules}>
                  {(rule) => (
                    <box flexDirection="column">
                      <box flexDirection="row" gap={1}>
                        <text fg={effectColor(rule.effect)}>{rule.effect}</text>
                        <text fg={theme.text.base} wrapMode="word">
                          <b>{rule.action}</b>{" "}
                          <span style={{ fg: theme.text.muted }}>{rule.resource}</span>
                        </text>
                      </box>
                      <Show when={rule.reason !== undefined && rule.reason.length > 0}>
                        <text fg={theme.text.muted} wrapMode="word">
                          {"  reason: "}
                          {rule.reason}
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </Show>
    </DialogLayout>
  )
}
