/**
 * The low-frequency native surfaces.
 *
 * Each surface reads one documented host fact and says so when the fact is absent; none of them invents
 * a row. Sources: knowledge/native-features.md:59-71 and knowledge/source-documents/03-omo-feature-presentation.md:93-121.
 *
 * - CodeMode activity arrives as an `extension_event` named `wake_source_state` with
 *   `{ source, activeCount, items: [{ id, description, startedAtMs }] }`
 *   (upstream/senpi/packages/coding-agent/docs/rpc.md:379-382);
 * - boulder/loop state is a status entry the host sets with `setStatus` (statusKey mentions boulder or loop);
 * - a terminal monitor, LSP attached text, computer-use hints, the search widget and brand are CLIENT
 *   surfaces: the host publishes no frame for them, so they are reported as unavailable instead of faked.
 */
export type CodeModeItem = {
  readonly id: string
  readonly description: string
  readonly startedAtMs: number | undefined
}

export type CodeModeActivity = {
  readonly source: string
  readonly activeCount: number
  readonly items: readonly CodeModeItem[]
}

export type OtherSurface<T> =
  | { readonly kind: "reported"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string }

export type OtherState = {
  readonly codeMode: OtherSurface<CodeModeActivity>
  readonly boulder: OtherSurface<string>
  readonly terminalMonitor: OtherSurface<never>
  readonly lspText: OtherSurface<never>
  readonly computerUse: OtherSurface<never>
  readonly searchWidget: OtherSurface<never>
  readonly brand: OtherSurface<never>
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function decodeCodeMode(raw: unknown): CodeModeActivity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const source = text(field(raw, "source"))
  const activeCount = field(raw, "activeCount")
  if (source === undefined) return undefined
  if (typeof activeCount !== "number" || !Number.isInteger(activeCount) || activeCount < 0) return undefined
  const rawItems = field(raw, "items")
  if (rawItems !== undefined && !Array.isArray(rawItems)) return undefined
  const items: CodeModeItem[] = []
  for (const entry of Array.isArray(rawItems) ? rawItems : []) {
    if (typeof entry !== "object" || entry === null) return undefined
    const id = text(field(entry, "id"))
    const description = text(field(entry, "description"))
    if (id === undefined || description === undefined) return undefined
    const started = field(entry, "startedAtMs")
    if (started !== undefined && typeof started !== "number") return undefined
    items.push({ id: id, description: description, startedAtMs: typeof started === "number" ? started : undefined })
  }
  return { source: source, activeCount: activeCount, items: items }
}

export const UNAVAILABLE_REASON = "The host publishes no frame for this surface, so the bridge cannot show it."

export function initialOtherState(): OtherState {
  return {
    codeMode: { kind: "unavailable", reason: "No wake_source_state event has arrived yet." },
    boulder: { kind: "unavailable", reason: "No boulder or loop status entry has arrived yet." },
    terminalMonitor: { kind: "unavailable", reason: UNAVAILABLE_REASON },
    lspText: { kind: "unavailable", reason: UNAVAILABLE_REASON },
    computerUse: { kind: "unavailable", reason: UNAVAILABLE_REASON },
    searchWidget: { kind: "unavailable", reason: UNAVAILABLE_REASON },
    brand: { kind: "unavailable", reason: UNAVAILABLE_REASON },
  }
}
