/**
 * Right-panel exclusivity for the DAG view.
 *
 * The DAG panel shares the right column with the terminal and the sidebar, so exactly one is open at
 * a time: opening one closes the others instead of letting two claim the same space. The chosen panel
 * is small enough to persist, which is what restores it when the app reopens.
 */
export type RightPanel = "none" | "terminal" | "sidebar" | "dag";

export type PanelState = {
  readonly current: () => RightPanel;
  /** Opens one panel, closes whatever else was open, and returns the panel now shown. */
  readonly open: (panel: RightPanel) => RightPanel;
  readonly close: () => RightPanel;
  /** Restores a persisted choice; an unknown value restores "none" rather than guessing. */
  readonly restore: (value: unknown) => RightPanel;
  readonly serialize: () => RightPanel;
};

export function createPanelState(initial: RightPanel = "none"): PanelState {
  let current: RightPanel = initial;
  return {
    current: () => current,
    open(panel) {
      current = panel;
      return current;
    },
    close() {
      current = "none";
      return current;
    },
    restore(value) {
      current = value === "terminal" || value === "sidebar" || value === "dag" ? value : "none";
      return current;
    },
    serialize: () => current,
  };
}
