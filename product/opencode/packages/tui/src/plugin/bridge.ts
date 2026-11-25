import type { OpenCodeClient } from "@opencode/client"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts"
import { UnimplementedApiGroup } from "../../../bridge-core/src/client-surface.ts"

/**
 * The bridge seam of the TUI plugin host.
 *
 * The public `@opencode/plugin/tui` contract is unchanged: a plugin still receives the full
 * `Context` (`client`, `data`, `renderer`, `ui`, `keymap`, `storage`, `slots`, …) built by the
 * host. In bridge mode the transport-dependent members are answered by the in-process adapter
 * instead of a server: `data` is the bridge data layer, and `client` is the bridge client facade.
 * Members that read local host services (`renderer`, `ui`, `keymap`, `storage`, `slots`) are the
 * host's own and need no adaptation.
 *
 * The facade does not invent values. A client member this bridge cannot answer throws
 * `UnsupportedCapability` and is reported through the activation's report sink, so a plugin fails
 * loudly instead of reading an empty list or object that would look like real state.
 *
 * What this does not claim: compatibility with arbitrary future plugins or with plugin packages
 * written against another OpenCode version. Only the fixed fork's public contract is kept, and a
 * plugin that needs an unbacked member degrades as described above. Plugins run in-process with no
 * sandbox, so the trust boundary is a local one; see `admitsBridgePlugin`.
 */
export type CapabilityReport = (capability: string) => void

/**
 * The in-process bridge adapter is the only data layer that delivers validated host frames, so
 * `onHostEvent` identifies bridge mode without importing the adapter or guessing from the transport.
 */
export function isBridgeBacked(data: Plugin.Context["data"]): boolean {
  return typeof readMember(data, "onHostEvent") === "function"
}

/** Reads a member the caller only knows by key: the API's own types declare no index signature. */
function readMember(target: object, property: string | symbol): unknown {
  return (target as Record<PropertyKey, unknown>)[property]
}

/**
 * Bridge mode has no persisted TUI configuration and installs no packages, so the only local plugin
 * source is the user's own config plugin directory (the first entry `localPluginDirectories`
 * returns). A project directory can belong to someone else's checkout, so a plugin discovered there
 * is reported and left unloaded unless the user listed it explicitly, which is the explicit-enable
 * path in bridge mode. Containment is lexical: a symlink the user placed inside their own plugin
 * directory is part of that user's trust decision.
 */
export function admitsBridgePlugin(candidate: string, trustedDirectory: string): boolean {
  const relative = path.relative(path.resolve(trustedDirectory), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)
}

/**
 * A plugin-facing view of the bridge client. Implemented members answer from the adapter; a member
 * the adapter rejects with `UnimplementedApiGroup` is reported and rethrown as
 * `UnsupportedCapability` naming the member. `client.rpc` is among the unbacked members: the bridge
 * has no RPC command surface, so calling it throws there instead of returning an empty domain.
 */
export function bridgePluginClient(api: OpenCodeClient, report: CapabilityReport): OpenCodeClient {
  return guardedView(api, "client", report)
}

function guardedView<T extends object>(target: T, capability: string, report: CapabilityReport): T {
  return new Proxy(target, {
    get(source, property) {
      const value: unknown = readMember(source, property)
      const member = capability.length === 0 ? String(property) : capability + "." + String(property)
      if (isCallable(value)) return guardedCall(value, member, report)
      if (typeof value === "object" && value !== null) return guardedView(value, member, report)
      return value
    },
  })
}

type Callable = (...args: never[]) => unknown

function isCallable(value: unknown): value is Callable {
  return typeof value === "function"
}

function guardedCall(call: Callable, capability: string, report: CapabilityReport): Callable {
  return new Proxy(call, {
    apply(target, thisArg, args) {
      try {
        return Function.prototype.apply.call(target, thisArg, args)
      } catch (error) {
        if (!(error instanceof UnimplementedApiGroup)) throw error
        report(capability)
        throw new UnsupportedCapability(capability)
      }
    },
    // Callable members carry their own members (`rpc.call`); those fail on use instead of disappearing.
    get(target, property) {
      const value: unknown = readMember(target, property)
      const member = capability + "." + String(property)
      if (isCallable(value)) return guardedCall(value, member, report)
      if (typeof value === "object" && value !== null) return guardedView(value, member, report)
      return value
    },
  })
}
