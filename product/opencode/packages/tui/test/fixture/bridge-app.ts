import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import type { Config } from "../../src/config"
import type { LogSink } from "../../src/context/log"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts"
import { InteractionController } from "../../../bridge-core/src/interaction.ts"
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts"
import { createBridgeTuiContext } from "../../src/context/bridge.ts"

/**
 * Boots the real TUI against the in-process bridge adapter, mirroring `createAppFixture` for bridge
 * mode: no server endpoint, no HTTP client, and the caller's root owns the home and config
 * directories so plugins are discovered from an isolated plugin directory.
 */
export async function createBridgeAppFixture(input: {
  root: string
  data: BridgeData
  config?: Config.Info
  log?: LogSink
  width?: number
  height?: number
}) {
  const { run } = await import("../../src/app")
  const home = path.join(input.root, "home")
  const configDirectory = path.join(home, ".config", "opencode")
  const setup = await createTestRenderer({
    width: input.width ?? 100,
    height: input.height ?? 30,
    kittyKeyboard: true,
  })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  let configInfo: Config.Info = structuredClone(input.config ?? { animations: false })
  const bridge = createBridgeTuiContext(
    {
      data: input.data,
      defaultLocation: { directory: input.root },
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
    },
    () => "ready",
  )
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { local: true },
      config: {
        get: async () => configInfo,
        update: async (mutate) => {
          const next = structuredClone(configInfo)
          mutate(next)
          configInfo = next
          return next
        },
      },
      packages: {
        prepare: async () => {
          throw new Error("bridge fixture installs no plugin packages")
        },
      },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: {},
      bridgeData: bridge.tuiData,
      bridgeApi: bridge.api,
      log: input.log ?? (() => {}),
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: home,
          data: path.join(input.root, "data"),
          cache: path.join(input.root, "cache"),
          config: configDirectory,
          state: path.join(input.root, "state"),
          bin: path.join(input.root, "cache", "bin"),
          log: path.join(input.root, "data", "log"),
          repos: path.join(input.root, "data", "repos"),
          tmp: path.join(input.root, "tmp"),
        }),
      ),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    pluginDirectory: path.join(configDirectory, "plugins"),
    ready: ready.promise,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        ready.resolve()
      }
    },
  }
}
