import { For, Show, createMemo } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../../context/theme";
import type { DagLedger } from "./state.ts";

export type DagPanelProps = {
  readonly ledger: DagLedger;
  /** Columns the parent offers; the panel never claims more than it was given. */
  readonly available?: number;
};

/**
 * The DAG right panel. It renders what the ledger holds and says plainly when a run has a gap that
 * history has not closed yet, rather than drawing a contiguous timeline it cannot prove.
 */
export function DagPanel(props: DagPanelProps) {
  const theme = useTheme();
  /* one memo over the ledger revision, so every mutation redraws the rows and their heads */
  const rows = createMemo(() => {
    props.ledger.version();
    return props.ledger.runs().map((run) => ({
      runId: run.runId,
      status: run.status,
      head: props.ledger.head(run.runId),
      pendingGap: props.ledger.gap(run.runId) !== undefined,
      recent: props.ledger.events(run.runId).slice(-5).map((event) => event.seq),
    }));
  });
  const heartbeat = createMemo(() => {
    props.ledger.version();
    return props.ledger.heartbeatAt();
  });
  return (
    <box flexDirection="column" width={props.available}>
      <text attributes={TextAttributes.BOLD} fg={theme.text.base}>DAG</text>
      <Show when={rows().length > 0} fallback={<text fg={theme.text.muted}>The host has not reported any DAG run.</text>}>
        <For each={rows()}>
          {(run) => (
            <box flexDirection="column">
              <text fg={theme.text.base}>{run.runId}  {run.status}</text>
              <text fg={theme.text.muted}>
                {"seq " + String(run.head)}
                {run.pendingGap ? "  gap: waiting for history" : ""}
              </text>
              <For each={run.recent}>
                {(seq) => <text fg={theme.text.muted}>{"  " + String(seq)}</text>}
              </For>
            </box>
          )}
        </For>
      </Show>
      <Show when={heartbeat() !== null}>
        <text fg={theme.text.muted}>{"last heartbeat " + String(heartbeat())}</text>
      </Show>
    </box>
  );
}
