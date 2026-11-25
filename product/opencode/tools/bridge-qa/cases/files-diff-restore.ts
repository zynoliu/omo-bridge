import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { createFilesStore } from "../../../packages/tui/src/bridge/features/files/index.ts"

const SESSION = "qa-files-diff-restore"
const ORIGINAL = "bridge checkpoint original\n"
const EDITED = "bridge user edit after checkpoint\n"

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
  /* On macOS /tmp is a symlink to /private/tmp, so both sides of this comparison are taken through
     realpath: comparing a resolved root against an unresolved shadow path fails for a reason that has
     nothing to do with the store. */
  fs.mkdirSync(shadow, { recursive: true, mode: 0o700 })
  const realRoot = fs.realpathSync(root)
  const realHome = fs.realpathSync(home)
  const realShadow = fs.realpathSync(shadow)
  const target = path.join(realRoot, "notes.txt")
  fs.writeFileSync(target, ORIGINAL)

  const store = createFilesStore({ shadowRoot: shadow, homeDirectory: () => realHome })
  const authorized = store.authorize(SESSION, realRoot)
  if (authorized.kind === "refused") throw new Error("authorize refused: " + authorized.code + " " + authorized.message)
  checks.push({
    name: "root-authorized",
    expected: "one explicit authorization for the synthetic fixture root",
    observed: authorized.root + " with shadow store " + authorized.shadowRoot,
    pass: authorized.root === realRoot && authorized.shadowRoot === realShadow,
  })

  const beforeEdit = readText(target)
  const checkpoint = store.checkpoint(SESSION, ".")
  if (checkpoint.kind === "refused") throw new Error("checkpoint refused: " + checkpoint.code + " " + checkpoint.message)
  const manifestPath = path.join(shadow, checkpoint.manifest.id, "manifest.json")
  const objectPath = path.join(shadow, "objects", digest(ORIGINAL))
  checks.push({
    name: "checkpoint-in-shadow-store",
    expected: "a manifest and one content object under the product-owned shadow store",
    observed: "manifest " + String(fs.existsSync(manifestPath)) + ", object " + String(fs.existsSync(objectPath)),
    pass: fs.existsSync(manifestPath) && fs.existsSync(objectPath),
  })
  checks.push({
    name: "checkpoint-records-path-digest-mode",
    expected: "notes.txt captured with its path, digest and mode",
    observed: JSON.stringify(checkpoint.manifest.items.find((item) => item.path === "notes.txt")),
    pass: checkpoint.manifest.items.some((item) => item.path === "notes.txt" && item.digest === digest(ORIGINAL) && item.mode !== null),
  })

  fs.writeFileSync(target, EDITED)
  const read = store.read(SESSION, "notes.txt")
  if (read.kind === "refused") throw new Error("read refused: " + read.code + " " + read.message)
  checks.push({
    name: "read-reports-digest",
    expected: "the edited content and its own sha-256 digest",
    observed: read.digest,
    pass: read.digest === digest(EDITED) && Buffer.from(read.content).toString("utf8") === EDITED,
  })

  const diff = store.diff(SESSION, checkpoint.manifest.id)
  if (diff.kind === "refused") throw new Error("diff refused: " + diff.code + " " + diff.message)
  const changed = diff.items.find((item) => item.path === "notes.txt")
  checks.push({
    name: "diff-reports-change",
    expected: "notes.txt modified, checkpoint digest to disk digest",
    observed: JSON.stringify(changed) + ", changed " + String(diff.changed),
    pass:
      changed !== undefined &&
      changed.status === "modified" &&
      changed.checkpointDigest === digest(ORIGINAL) &&
      changed.diskDigest === digest(EDITED) &&
      diff.changed === 1,
  })

  const plan = store.planRestore(SESSION, checkpoint.manifest.id)
  if (plan.kind === "refused") throw new Error("planRestore refused: " + plan.code + " " + plan.message)
  checks.push({
    name: "plan-covers-one-file",
    expected: "one restorable item with a confirmation token",
    observed: "restorable " + String(plan.restorable) + ", token " + plan.token.slice(0, 12),
    pass: plan.restorable === 1 && plan.token.length === 64,
  })

  const restore = store.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: realRoot, token: plan.token })
  if (restore.kind === "refused") throw new Error("restore refused: " + restore.code + " " + restore.message)
  const afterRestore = readText(target)
  checks.push({
    name: "restore-applied-confirmed-plan",
    expected: "notes.txt applied after an explicit confirmation",
    observed: JSON.stringify(restore),
    pass: restore.kind === "restored" && restore.applied.length === 1 && restore.applied[0] === "notes.txt",
  })
  checks.push({
    name: "bytes-restored-to-checkpoint",
    expected: "the file holds the checkpointed bytes again",
    observed: afterRestore,
    pass: afterRestore === ORIGINAL && digest(afterRestore) === digest(beforeEdit),
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
    artifacts: [manifestPath, objectPath],
  }
}
