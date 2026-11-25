import { Plugin } from "@opencode/plugin/tui"
import { createMemo, onCleanup, Show } from "solid-js"
import type { JSX } from "solid-js"

import type { BridgeData } from "../../../../bridge-core/src/data.ts"
import type { BridgeTuiData } from "../../context/bridge-data.ts"
import { bridgeAdapters, bridgeStores } from "../../context/bridge-data.ts"
import { Status, createStatusStore, connectBridgeStatus } from "../../bridge/features/status/index.ts"
import { createTasksStore } from "../../bridge/features/tasks/store.ts"
import { connectBridgeTasks } from "../../bridge/features/tasks/connect.ts"
import { Tasks } from "../../bridge/features/tasks/view.tsx"
import { Sessions } from "../../bridge/features/sessions/view.tsx"
import { DagPanel, connectBridgeDag, createDagLedger } from "../../bridge/features/dag/index.ts"
import { Dialogs, createDialogsStore } from "../../bridge/features/dialogs/index.ts"
import type { DialogsStore } from "../../bridge/features/dialogs/store.ts"

/**
 * The bridge surfaces, mounted as a sidebar section only when the TUI runs on the in-process bridge.
 *
 * Each surface keeps its own store and its own connection, so a feed that answers one never fills
 * another. The column order is deliberate: the panels most likely to be looked at first sit where a
 * short terminal still draws them.
 */
function Section(props: { readonly children: JSX.Element }) {
  return (
    <box height={8} flexShrink={0}>
      <scrollbox flexGrow={1} minHeight={0}>
        <box flexDirection="column">{props.children}</box>
      </scrollbox>
    </box>
  )
}

function DialogsSection(props: { readonly dialogs: BridgeTuiData | undefined; readonly store: DialogsStore | undefined }) {
  const raw = props.dialogs
  const store = props.store
  if (raw === undefined || store === undefined) return null
  return <Dialogs data={raw} store={store} />
}

export function BridgeSidebar(props: {
  readonly sessionID: string
  readonly data: BridgeData | undefined
  readonly adapter: BridgeTuiData | undefined
}) {
  const raw = props.data
  if (raw === undefined) return null
  return <SurfaceBody sessionID={props.sessionID} data={raw} adapter={props.adapter} />
}

function SurfaceBody(props: {
  readonly sessionID: string
  readonly data: BridgeData
  readonly adapter: BridgeTuiData | undefined
}) {
  const status = createStatusStore({ sessionID: props.sessionID })
  const stopStatus = connectBridgeStatus(status, props.data)
  const tasks = createTasksStore({ sessionID: props.sessionID })
  const stopTasks = connectBridgeTasks(tasks, props.data, { sessionID: props.sessionID })
  const ledger = createDagLedger()
  const stopDag = connectBridgeDag(ledger, props.data)
  /* The dialog block only takes space while the host is actually waiting on an answer. */
  /*
   * One store for the section, hoisted here so the section's own lifetime does not decide what is
   * remembered: an answered dialog stays in the store as settled, and the section keeps drawing it.
   * Gating on the host's open list instead unmounted the panel the moment an answer went out, which is why
   * the settled line never reached the screen.
   */
  const dialogStore = props.adapter === undefined ? undefined : createDialogsStore({ data: props.adapter })
  const dialogs = props.adapter?.hostDialogs
  const stopDialogs = dialogs === undefined ? () => {} : dialogs.subscribe(() => undefined)
  onCleanup(() => {
    stopStatus()
    stopTasks()
    stopDag()
    stopDialogs()
  })

  return (
    <scrollbox flexGrow={1} minHeight={0}>
      <box flexDirection="column">
        <Show when={dialogStore !== undefined && dialogStore.entries().length > 0}>
          <DialogsSection dialogs={props.adapter} store={dialogStore} />
        </Show>
        {/* Each section keeps a fixed slice so every header stays on screen at 120x40; a section
            larger than its slice scrolls on its own instead of pushing the next one out of view. */}
        <Section><DagPanel ledger={ledger} /></Section>
        <Section><Tasks store={tasks} /></Section>
        <Section><Status store={status} /></Section>
        {/* Sessions is last: in a short terminal the tab bar above already names the sessions, and
            this section keeps its own scroll area rather than pushing the others off screen. */}
        <Show when={props.adapter}>
          {(bridge) => (
            <Section><Sessions data={bridge()} sessions={bridge().sessionRegistry} /></Section>
          )}
        </Show>
      </box>
    </scrollbox>
  )
}

function BridgeSurfaces(props: { readonly context: Plugin.Context; readonly sessionID: string }) {
  const data = createMemo(() => bridgeStores.get(props.context.data))
  const adapter = createMemo(() => bridgeAdapters.get(props.context.data))
  return (
    <Show when={data()}>
      {(store) => <BridgeSidebar sessionID={props.sessionID} data={store()} adapter={adapter()} />}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.bridge.surfaces",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <BridgeSurfaces context={context} sessionID={props.sessionID} />,
    })
  },
})
