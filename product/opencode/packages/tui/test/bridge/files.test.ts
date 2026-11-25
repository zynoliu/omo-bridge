import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFilesStore } from "../../src/bridge/features/files/index.ts";
import type {
  AuthorizedReceipt,
  CheckpointReceipt,
  DiffItem,
  DiffReceipt,
  FilesRefusal,
  FilesStore,
  ListingReceipt,
  ReadReceipt,
  RestorePlan,
  RestoreReceipt,
  WriteBytes,
} from "../../src/bridge/features/files/index.ts";

const SESSION = "session-alpha";

type Fixture = {
  readonly root: string;
  readonly shadow: string;
  readonly home: string;
  readonly outside: string;
};

const fixtures: string[] = [];

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "bridge-t18-"));
  const root = path.join(base, "work");
  const home = path.join(base, "home");
  const outside = path.join(base, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  fixtures.push(base);
  return {
    root: realpathSync(root),
    shadow: path.join(base, "shadow"),
    home: realpathSync(home),
    outside: realpathSync(outside),
  };
}

afterEach(() => {
  for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true });
});

function storeFor(fx: Fixture, writeBytes?: WriteBytes): FilesStore {
  return createFilesStore({ shadowRoot: fx.shadow, homeDirectory: () => fx.home, writeBytes: writeBytes });
}

function authorized(store: FilesStore, fx: Fixture): void {
  const receipt = store.authorize(SESSION, fx.root);
  if (receipt.kind === "refused") throw new Error("authorize was refused: " + receipt.code + " " + receipt.message);
}

function listed(receipt: ListingReceipt | FilesRefusal): ListingReceipt {
  if (receipt.kind === "refused") throw new Error("list was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

function read(receipt: ReadReceipt | FilesRefusal): ReadReceipt {
  if (receipt.kind === "refused") throw new Error("read was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

function checkpointed(receipt: CheckpointReceipt | FilesRefusal): CheckpointReceipt {
  if (receipt.kind === "refused") throw new Error("checkpoint was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

function diffed(receipt: DiffReceipt | FilesRefusal): DiffReceipt {
  if (receipt.kind === "refused") throw new Error("diff was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

function planned(receipt: RestorePlan | FilesRefusal): RestorePlan {
  if (receipt.kind === "refused") throw new Error("planRestore was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

function restored(receipt: RestoreReceipt | FilesRefusal): RestoreReceipt {
  if (receipt.kind === "refused") throw new Error("restore was refused: " + receipt.code + " " + receipt.message);
  return receipt;
}

type Refusable =
  | FilesRefusal
  | AuthorizedReceipt
  | ListingReceipt
  | ReadReceipt
  | CheckpointReceipt
  | DiffReceipt
  | RestorePlan
  | RestoreReceipt;

function refusalOf(receipt: Refusable): FilesRefusal {
  if (receipt.kind !== "refused") throw new Error("expected a refusal, received " + receipt.kind);
  return receipt;
}

function diffItemAt(diff: DiffReceipt, relative: string): DiffItem {
  const found = diff.items.find((item) => item.path === relative);
  if (found === undefined) throw new Error("diff has no item for " + relative);
  return found;
}

function entryAt(receipt: ListingReceipt, relative: string): ListingReceipt["entries"][number] {
  const found = receipt.entries.find((entry) => entry.path === relative);
  if (found === undefined) throw new Error("listing has no entry for " + relative);
  return found;
}

function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bytesOf(target: string): string {
  return readFileSync(target).toString("utf8");
}

describe("bridge files", () => {
  test("listing is confined to the authorized root", () => {
    const fx = fixture();
    writeFileSync(path.join(fx.root, "a.txt"), "alpha\n");
    mkdirSync(path.join(fx.root, "nested"));
    writeFileSync(path.join(fx.root, "nested", "b.txt"), "beta\n");
    writeFileSync(path.join(fx.outside, "secret.txt"), "outside content\n");
    symlinkSync(path.join(fx.outside, "secret.txt"), path.join(fx.root, "escape-file"));
    symlinkSync(fx.outside, path.join(fx.root, "escape-dir"));
    const store = storeFor(fx);
    authorized(store, fx);

    const listing = listed(store.list(SESSION, "."));
    expect(listing.root).toBe(fx.root);
    expect(listing.entries.map((entry) => entry.path)).toEqual(["a.txt", "escape-dir", "escape-file", "nested"]);
    expect(entryAt(listing, "a.txt").kind).toBe("file");
    expect(entryAt(listing, "nested").kind).toBe("directory");
    expect(entryAt(listing, "escape-file").kind).toBe("symlink");
    expect(entryAt(listing, "escape-file").escapes).toBe(true);
    expect(entryAt(listing, "escape-dir").escapes).toBe(true);
    expect(listing.entries.some((entry) => entry.path === "secret.txt")).toBe(false);
  });

  test("a symlink or .. escape is refused", () => {
    const fx = fixture();
    writeFileSync(path.join(fx.root, "a.txt"), "alpha\n");
    writeFileSync(path.join(fx.outside, "secret.txt"), "outside content\n");
    symlinkSync(path.join(fx.outside, "secret.txt"), path.join(fx.root, "escape-file"));
    symlinkSync(fx.outside, path.join(fx.root, "escape-dir"));
    const store = storeFor(fx);
    authorized(store, fx);

    expect(refusalOf(store.read(SESSION, "escape-file")).code).toBe("outside-root");
    expect(refusalOf(store.read(SESSION, "escape-dir/secret.txt")).code).toBe("outside-root");
    expect(refusalOf(store.list(SESSION, "escape-dir")).code).toBe("outside-root");
    expect(refusalOf(store.read(SESSION, "../outside/secret.txt")).code).toBe("path-escape");
    expect(refusalOf(store.list(SESSION, "..")).code).toBe("path-escape");
    expect(refusalOf(store.checkpoint(SESSION, "escape-dir/secret.txt")).code).toBe("outside-root");
    expect(refusalOf(store.read(SESSION, path.join(fx.outside, "secret.txt"))).code).toBe("path-escape");
    expect(existsSync(fx.shadow)).toBe(false);
  });

  test("read returns content with its digest", () => {
    const fx = fixture();
    const content = "bridge file content\n";
    writeFileSync(path.join(fx.root, "notes.txt"), content);
    const store = storeFor(fx);
    authorized(store, fx);

    const receipt = read(store.read(SESSION, "notes.txt"));
    expect(receipt.path).toBe("notes.txt");
    expect(receipt.digest).toBe(digestOf(content));
    expect(receipt.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(Buffer.from(receipt.content).toString("utf8")).toBe(content);
    expect(receipt.mode & 0o600).toBe(0o600);
  });

  test("an unauthorized session cannot reach the authorized directory", () => {
    const fx = fixture();
    writeFileSync(path.join(fx.root, "a.txt"), "alpha\n");
    const store = storeFor(fx);
    authorized(store, fx);

    expect(refusalOf(store.list("session-beta", ".")).code).toBe("unbound-session");
    expect(refusalOf(store.read("session-beta", "a.txt")).code).toBe("unbound-session");
    expect(refusalOf(store.checkpoint("session-beta", ".")).code).toBe("unbound-session");
  });

  test("the authorized directory and the shadow store are validated", () => {
    const fx = fixture();
    writeFileSync(path.join(fx.root, "a.txt"), "alpha\n");
    const store = storeFor(fx);
    expect(refusalOf(store.authorize("session-beta", path.dirname(fx.home))).code).toBe("root-reaches-home");

    const overlapping = createFilesStore({ shadowRoot: path.join(fx.root, "shadow"), homeDirectory: () => fx.home });
    expect(refusalOf(overlapping.authorize("session-beta", fx.root)).code).toBe("shadow-overlaps-root");

    const inHome = createFilesStore({ shadowRoot: path.join(fx.home, "shadow"), homeDirectory: () => fx.home });
    expect(refusalOf(inHome.authorize("session-beta", fx.root)).code).toBe("shadow-reaches-home");
  });

  test("diff reports a change between checkpoint and disk", () => {
    const fx = fixture();
    const target = path.join(fx.root, "notes.txt");
    writeFileSync(target, "first\n");
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    const checkpointItem = checkpoint.manifest.items.find((item) => item.path === "notes.txt");
    expect(checkpointItem === undefined ? null : checkpointItem.digest).toBe(digestOf("first\n"));
    expect(existsSync(path.join(fx.shadow, checkpoint.manifest.id, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(fx.shadow, "objects", digestOf("first\n")))).toBe(true);
    expect(existsSync(path.join(fx.root, ".git"))).toBe(false);

    writeFileSync(target, "second\n");
    const diff = diffed(store.diff(SESSION, checkpoint.manifest.id));
    const changed = diffItemAt(diff, "notes.txt");
    expect(changed.status).toBe("modified");
    expect(changed.checkpointDigest).toBe(digestOf("first\n"));
    expect(changed.diskDigest).toBe(digestOf("second\n"));
    expect(diff.changed).toBe(1);
  });

  test("a checkpoint keeps ignore and mode metadata without touching git", () => {
    const fx = fixture();
    mkdirSync(path.join(fx.root, ".git"));
    writeFileSync(path.join(fx.root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(fx.root, "notes.txt"), "content\n", { mode: 0o600 });
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    const ignored = checkpoint.manifest.items.find((item) => item.path === ".git");
    const captured = checkpoint.manifest.items.find((item) => item.path === "notes.txt");
    const capturedDigest = captured === undefined ? null : captured.digest;
    const capturedMode = captured === undefined ? null : captured.mode;
    expect(ignored === undefined ? null : ignored.kind).toBe("ignored");
    expect(capturedDigest).toBe(digestOf("content\n"));
    expect(capturedMode).toBe(0o600);
    expect(checkpoint.objects).toBe(1);
    expect(readdirSync(path.join(fx.root, ".git"))).toEqual(["HEAD"]);
    expect(bytesOf(path.join(fx.root, ".git", "HEAD"))).toBe("ref: refs/heads/main\n");
  });

  test("restore returns the original bytes when nothing changed", () => {
    const fx = fixture();
    const target = path.join(fx.root, "notes.txt");
    writeFileSync(target, "stable\n");
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    const plan = planned(store.planRestore(SESSION, checkpoint.manifest.id));
    expect(plan.restorable).toBe(0);
    const receipt = restored(store.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: fx.root, token: plan.token }));
    expect(receipt.kind).toBe("restored");
    if (receipt.kind !== "restored") throw new Error("restore was not a restored receipt");
    expect(receipt.applied).toEqual([]);
    expect(receipt.unchanged).toEqual(["notes.txt"]);
    expect(receipt.kept).toEqual([]);
    expect(bytesOf(target)).toBe("stable\n");
    expect(digestOf(bytesOf(target))).toBe(digestOf("stable\n"));
  });

  test("restore reverts a confirmed change to the checkpointed bytes", () => {
    const fx = fixture();
    const target = path.join(fx.root, "notes.txt");
    writeFileSync(target, "original\n");
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    writeFileSync(target, "edited after the checkpoint\n");
    const plan = planned(store.planRestore(SESSION, checkpoint.manifest.id));
    expect(plan.restorable).toBe(1);
    const receipt = restored(store.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: fx.root, token: plan.token }));
    expect(receipt.kind).toBe("restored");
    if (receipt.kind !== "restored") throw new Error("restore was not a restored receipt");
    expect(receipt.applied).toEqual(["notes.txt"]);
    expect(bytesOf(target)).toBe("original\n");
    expect(digestOf(bytesOf(target))).toBe(digestOf("original\n"));
  });

  test("restore refuses when the file was edited after the checkpoint and leaves the newer content untouched", () => {
    const fx = fixture();
    const target = path.join(fx.root, "notes.txt");
    writeFileSync(target, "original\n");
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    writeFileSync(target, "user edit one\n");
    const plan = planned(store.planRestore(SESSION, checkpoint.manifest.id));
    writeFileSync(target, "user edit two\n");
    const receipt = store.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: fx.root, token: plan.token });
    expect(receipt.kind).toBe("refused");
    expect(refusalOf(receipt).code).toBe("stale-confirmation");
    expect(bytesOf(target)).toBe("user edit two\n");
    expect(digestOf(bytesOf(target))).toBe(digestOf("user edit two\n"));
    expect(existsSync(path.join(fx.shadow, "objects", digestOf("original\n")))).toBe(true);
  });

  test("a partial failure is reported rather than half-applied", () => {
    const fx = fixture();
    const first = path.join(fx.root, "a.txt");
    const second = path.join(fx.root, "b.txt");
    writeFileSync(first, "original a\n");
    writeFileSync(second, "original b\n");
    const store = storeFor(fx);
    authorized(store, fx);

    const checkpoint = checkpointed(store.checkpoint(SESSION, "."));
    writeFileSync(first, "edited a\n");
    writeFileSync(second, "edited b\n");
    const plan = planned(store.planRestore(SESSION, checkpoint.manifest.id));
    expect(plan.restorable).toBe(2);

    const failing = storeFor(fx, (target, bytes, mode) => {
      if (target === second) throw new Error("injected write failure");
      writeFileSync(target, bytes);
      chmodSync(target, mode);
    });
    authorized(failing, fx);
    const receipt = restored(failing.restore(SESSION, { checkpointID: checkpoint.manifest.id, root: fx.root, token: plan.token }));
    expect(receipt.kind).toBe("partial");
    if (receipt.kind !== "partial") throw new Error("restore was not a partial receipt");
    expect(receipt.applied).toEqual(["a.txt"]);
    expect(receipt.pending).toEqual(["b.txt"]);
    expect(receipt.failed.path).toBe("b.txt");
    expect(receipt.failed.code).toBe("restore-failed");
    expect(bytesOf(first)).toBe("original a\n");
    expect(bytesOf(second)).toBe("edited b\n");
  });
});
