import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { createFilesStore } from "../../../packages/tui/src/bridge/features/files/index.ts"

const SESSION = "qa-files-conflicting-edit"
const ORIGINAL = "bridge checkpoint original\n"
const FIRST_EDIT = "bridge user edit one\n"
const SECOND_EDIT = "bridge user edit two, newer than the confirmed plan\n"

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function readText(target: string): string {
  return fs.readFileSync(target).toString("utf8")
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = []
  const fixture = path.join(context.out, "fixture")
  const root = path.join(fixture, "work")
  const home = path.join(fixture, "home")
  const shadow = path.join(fixture, "shadow")
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const realRoot = fs.realpathSync(root)
  const realHome = fs.realpathSync(home)
  const target = path.join(realRoot, "notes.txt")
  fs.writeFileSync(target, ORIGINAL)

  const store = createFilesStore({ shadowRoot: shadow, homeDirectory: () => realHome })
  const authorized = store.authorize(SESSION, realRoot)
  if (authorized.kind === "refused") throw new Error("authorize refused: " + authorized.code + " " + authorized.message)
  const checkpoint = store.checkpoint(SESSION, ".")
  if (checkpoint.kind === "refused") throw new Error("checkpoint refused: " + checkpoint.code + " " + checkpoint.message)

  fs.writeFileSync(target, FIRST_EDIT)
  const plan = store.planRestore(SESSION, checkpoint.manifest.id)
  if (plan.kind === "refused") throw new Error("planRestore refused: " + plan.code + " " + plan.message)
  checks.push({
    name: "plan-confirmed-later-edit",
    expected: "the plan names the user's first edit as the state to be replaced",
    observed: JSON.stringify(plan.items.find((item) => item.path === "notes.txt")),
    pass: plan.restorable === 1 && plan.items.some((item) => item.path === "notes.txt" && item.expectedDigest === digest(FIRST_EDIT)),
  })

  fs.writeFileSync(target, SECOND_EDIT)
  const restore = store.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: realRoot, token: plan.token })
  const refusedCode = restore.kind === "refused" ? restore.code : null
  checks.push({
    name: "restore-refuses-stale-confirmation",
    expected: "refused stale-confirmation rather than overwriting the newer edit",
    observed: restore.kind === "refused" ? restore.code + " " + restore.message : JSON.stringify(restore),
    pass: refusedCode === "stale-confirmation",
  })

  const afterRefusal = readText(target)
  checks.push({
    name: "newer-user-content-survives",
    expected: "the file still holds the user's newest bytes",
    observed: afterRefusal,
    pass: afterRefusal === SECOND_EDIT && digest(afterRefusal) === digest(SECOND_EDIT),
  })
  checks.push({
    name: "checkpoint-content-intact",
    expected: "the checkpoint object of the original content is still stored",
    observed: path.join(shadow, "objects", digest(ORIGINAL)),
    pass: fs.existsSync(path.join(shadow, "objects", digest(ORIGINAL))),
  })
  checks.push({
    name: "no-git-state-created",
    expected: "neither the fixture root nor the shadow store holds a Git directory",
    observed: JSON.stringify(fs.readdirSync(fixture).sort()),
    pass: !fs.existsSync(path.join(realRoot, ".git")) && !fs.existsSync(path.join(shadow, ".git")),
  })

  return {
    checks: checks,
    cleanup: {
      ok: true,
      detail: ["no process, socket or handle was created", "synthetic fixture kept at " + fixture],
    },
    artifacts: [path.join(shadow, checkpoint.manifest.id, "manifest.json")],
  }
}
