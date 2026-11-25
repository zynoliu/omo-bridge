import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { admitsBridgePlugin } from "../../src/plugin/bridge"
import { createBridgeAppFixture } from "../fixture/bridge-app"
import { tmpdir } from "../fixture/fixture"

const PLUGIN_ID = "fixture.bridge-contract"

function pluginSource(cleanupPath: string) {
  return `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: ${JSON.stringify(PLUGIN_ID)},
  async setup(context) {
    const sessions = context.data.session.list().map((session) => session.id).join(",")
    const listed = await context.client.session.list({})
    const [stored, update] = context.storage.store("probe", { initial: { runs: 0 } })
    await update((draft) => {
      draft.runs = draft.runs + 1
    })
    let missing = "none"
    try {
      context.client.file.list({})
    } catch (error) {
      missing = error instanceof Error && error.name === "UnsupportedCapability" ? error.capability : "unexpected"
    }
    let rpcMissing = "none"
    try {
      context.client.rpc({ id: "fixture.rpc", methods: {}, events: {} })
    } catch (error) {
      rpcMissing = error instanceof Error && error.name === "UnsupportedCapability" ? error.capability : "unexpected"
    }
    const surface = [
      typeof context.renderer.requestRender === "function" ? "renderer" : "no-renderer",
      typeof context.ui.dialog.show === "function" ? "ui" : "no-ui",
      typeof context.keymap.layer === "function" ? "keymap" : "no-keymap",
    ].join("+")
    context.ui.slot({
      append: "prompt.footer",
      render: () => (
        <text>
          bs data={sessions} client={listed.data.map((session) => session.id).join(",")} st={stored.runs} sf={surface} cap={missing} rpc={rpcMissing}
        </text>
      ),
    })
    return async () => {
      await Bun.write(${JSON.stringify(cleanupPath)}, "cleanup ran")
    }
  },
})
`
}

async function installPlugin(directory: string, name: string, source: string) {
  const target = path.join(directory, name)
  await mkdir(target, { recursive: true })
  await symlink(path.join(import.meta.dir, "../../node_modules"), path.join(target, "node_modules"))
  await Bun.write(path.join(target, "tui.tsx"), source)
}

function bridgeData() {
  const data = new BridgeData()
  data.upsertHostSession({
    id: "s1",
    projectID: "/workspace",
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Bridged",
    location: { directory: "/workspace" },
  })
  return data
}

describe("bridge plugin contract", () => {
  test("a plugin reads the bridge through its context, renders, persists, and is unloaded with its slot", async () => {
    await using root = await tmpdir()
    const cleanupPath = path.join(root.path, "cleanup.txt")
    const events: { level: string; message: string; tags: Record<string, unknown> }[] = []
    await installPlugin(path.join(root.path, "home", ".config", "opencode", "plugins"), "contract", pluginSource(cleanupPath))
    await using fixture = await createBridgeAppFixture({
      root: root.path,
      width: 160,
      height: 40,
      data: bridgeData(),
      log: (level, message, tags) => events.push({ level, message, tags }),
    })
    await fixture.ready

    /* The slot text is wider than one layout pass guarantees: waiting only for the data marker can hand the
       assertions a frame where the line is still clipped. Wait for the whole line the assertions need. */
    const frame = await fixture.waitForFrame(
      (current) => current.includes("bs data=s1") && current.includes("sf=renderer+ui+keymap"),
      { maxPasses: 600 },
    )
    expect(frame).toContain("client=s1")
    expect(frame).toContain("st=1")
    expect(frame).toContain("sf=renderer+ui+keymap")
    // A member the bridge cannot back fails loudly instead of answering an empty value.
    expect(frame).toContain("cap=client.file.list")
    expect(frame).toContain("rpc=client.rpc")
    const stored: unknown = JSON.parse(
      await Bun.file(path.join(root.path, "state", "test", "tui", "plugin." + PLUGIN_ID + ".probe.json")).text(),
    )
    expect(stored).toEqual({ runs: 1 })
    expect(events).toContainEqual({
      level: "warn",
      message: "plugin capability is not backed by the bridge adapter",
      tags: { component: "plugin", plugin: PLUGIN_ID, capability: "client.file.list" },
    })

    await rm(path.join(fixture.pluginDirectory, "contract"), { recursive: true, force: true })
    await fixture.waitForFrame((current) => !current.includes("bs data="), { maxPasses: 600 })
    expect(await Bun.file(cleanupPath).text()).toBe("cleanup ran")
  }, 60000)
})

describe("bridge plugin trust boundary", () => {
  test("only the user's own plugin directory is admitted", () => {
    const trusted = "/home/user/.config/opencode/plugins"
    expect(admitsBridgePlugin(path.join(trusted, "fixture"), trusted)).toBe(true)
    expect(admitsBridgePlugin(trusted, trusted)).toBe(false)
    expect(admitsBridgePlugin("/home/user/project/.opencode/plugins/fixture", trusted)).toBe(false)
    expect(admitsBridgePlugin("/home/user/.config/opencode/plugins-other/fixture", trusted)).toBe(false)
  })
})
