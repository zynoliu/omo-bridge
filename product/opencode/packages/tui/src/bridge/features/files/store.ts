import { chmodSync, closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { checkFilesSpec } from "./spec.ts";
import {
  checkRelative,
  comparePaths,
  isIgnored,
  MAX_CHECKPOINT_ENTRIES,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  planToken,
  refuse,
  sha256Hex,
  within,
} from "./state.ts";
import type {
  AuthorizedReceipt,
  CheckpointItem,
  CheckpointManifest,
  CheckpointReceipt,
  CheckpointScope,
  DiffItem,
  DiffReceipt,
  FileEntry,
  FileKind,
  FilesRefusal,
  ListingReceipt,
  ReadReceipt,
  RestoreConfirmation,
  RestoreItem,
  RestorePlan,
  RestoreReceipt,
} from "./state.ts";

export type WriteBytes = (target: string, bytes: Uint8Array, mode: number) => void;

export type FilesStoreDeps = {
  readonly shadowRoot: string;
  readonly homeDirectory?: () => string;
  readonly ignore?: readonly string[];
  readonly writeBytes?: WriteBytes;
};

export type FilesStore = {
  readonly authorize: (sessionID: string, root: string) => AuthorizedReceipt | FilesRefusal;
  readonly list: (sessionID: string, relative: string) => ListingReceipt | FilesRefusal;
  readonly read: (sessionID: string, relative: string) => ReadReceipt | FilesRefusal;
  readonly checkpoint: (sessionID: string, relative: string) => CheckpointReceipt | FilesRefusal;
  readonly diff: (sessionID: string, checkpointID: string) => DiffReceipt | FilesRefusal;
  readonly planRestore: (sessionID: string, checkpointID: string) => RestorePlan | FilesRefusal;
  readonly restore: (sessionID: string, confirmation: RestoreConfirmation) => RestoreReceipt | FilesRefusal;
};

type Binding = {
  readonly sessionID: string;
  readonly root: string;
  readonly shadowRoot: string;
};

type ResolvedTarget = {
  readonly kind: "resolved";
  readonly path: string;
  readonly absolute: string;
  readonly exists: boolean;
};

type BoundSession = { readonly kind: "bound"; readonly binding: Binding };

const OBJECTS = "objects";
const MANIFEST = "manifest.json";

/**
 * Owns the file surface of the sessions that authorized a directory. Every operation resolves a relative path
 * inside that directory first - lexically for `..`, then through `realpath` for symlinks - and refuses before
 * touching anything when the result leaves it. Checkpoints go to the product-owned shadow store only.
 */
export function createFilesStore(deps: FilesStoreDeps): FilesStore {
  const homeDirectory = deps.homeDirectory ?? (() => homedir());
  const ignore = deps.ignore ?? [];
  const writeBytes = deps.writeBytes ?? writeAtomically;
  const bindings = new Map<string, Binding>();
  const manifests = new Map<string, CheckpointManifest>();
  let counter = 0;

  const bind = (sessionID: string): BoundSession | FilesRefusal => {
    const held = bindings.get(sessionID);
    if (held === undefined) return refuse("unbound-session", "no authorized directory is bound to session " + sessionID);
    return { kind: "bound", binding: held };
  };

  const authorize = (sessionID: string, root: string): AuthorizedReceipt | FilesRefusal => {
    const checked = checkFilesSpec({ sessionID: sessionID, root: root, shadowRoot: deps.shadowRoot }, homeDirectory());
    if (checked.kind === "refused") return checked;
    const existing = bindings.get(checked.sessionID);
    if (existing !== undefined && existing.root !== checked.root) {
      return refuse("already-authorized", "session " + checked.sessionID + " is already bound to " + existing.root);
    }
    const binding: Binding = { sessionID: checked.sessionID, root: checked.root, shadowRoot: checked.shadowRoot };
    bindings.set(checked.sessionID, binding);
    return { kind: "authorized", sessionID: binding.sessionID, root: binding.root, shadowRoot: binding.shadowRoot };
  };

  const list = (sessionID: string, relative: string): ListingReceipt | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const target = resolveTarget(held, relative);
    if (target.kind === "refused") return target;
    if (!target.exists) return refuse("path-missing", target.path + " does not exist under the authorized directory");
    const info = lstatSync(target.absolute);
    if (!info.isDirectory()) return refuse("not-a-directory", target.path + " is not a directory");
    const names = readdirSync(target.absolute, { withFileTypes: true }).sort((first, second) => comparePaths(first.name, second.name));
    const entries = names.slice(0, MAX_LIST_ENTRIES).map((dirent) => entryOf(held, target.absolute, dirent.name, target.path));
    return {
      kind: "listed",
      root: held.root,
      directory: target.path === "" ? "." : target.path,
      entries: entries,
      truncated: names.length > MAX_LIST_ENTRIES,
    };
  };

  const read = (sessionID: string, relative: string): ReadReceipt | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const target = resolveTarget(held, relative);
    if (target.kind === "refused") return target;
    if (!target.exists) return refuse("path-missing", target.path + " does not exist under the authorized directory");
    const info = lstatSync(target.absolute);
    if (!info.isFile()) return refuse("not-a-file", target.path + " is not a regular file");
    if (info.size > MAX_FILE_BYTES) return refuse("file-too-large", target.path + " is larger than the " + String(MAX_FILE_BYTES) + " byte capture limit");
    const content = readFileSync(target.absolute);
    return {
      kind: "read",
      path: target.path,
      digest: sha256Hex(content),
      bytes: content.byteLength,
      mode: info.mode & 0o777,
      content: content,
    };
  };

  const checkpoint = (sessionID: string, relative: string): CheckpointReceipt | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const target = resolveTarget(held, relative);
    if (target.kind === "refused") return target;
    if (!target.exists) return refuse("path-missing", target.path + " does not exist under the authorized directory");
    const scopeInfo = lstatSync(target.absolute);
    const scopeKind: "file" | "directory" | null = scopeInfo.isDirectory() ? "directory" : scopeInfo.isFile() ? "file" : null;
    if (scopeKind === null) return refuse("not-a-file", target.path + " is neither a regular file nor a directory");
    const items: CheckpointItem[] = [];
    const digests = new Set<string>();
    const captured =
      scopeKind === "file"
        ? captureFile(held, target.absolute, target.path, items, digests)
        : captureDirectory(held, target.absolute, target.path, items, digests);
    if (captured.kind === "refused") return captured;
    counter = nextCheckpointNumber(held, counter);
    const id = checkpointID(counter);
    const manifest: CheckpointManifest = {
      version: 1,
      id: id,
      root: held.root,
      createdAt: new Date().toISOString(),
      scope: { path: target.path, kind: scopeKind },
      items: items,
    };
    mkdirSync(path.join(held.shadowRoot, id), { recursive: true, mode: 0o700 });
    writeAtomically(path.join(held.shadowRoot, id, MANIFEST), new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"), 0o600);
    manifests.set(id, manifest);
    return { kind: "checkpointed", manifest: manifest, objects: digests.size };
  };

  const diff = (sessionID: string, checkpointIDToDiff: string): DiffReceipt | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const manifold = loadManifest(held, checkpointIDToDiff, manifests);
    if (manifold.kind === "refused") return manifold;
    const manifest = manifold.manifest;
    const items = compareManifest(held, manifest, ignore);
    if (items.kind === "refused") return items;
    const changed = items.items.filter((item) => item.status === "modified" || item.status === "removed" || item.status === "added").length;
    return { kind: "diff", checkpointID: manifest.id, root: held.root, items: items.items, changed: changed };
  };

  const planRestore = (sessionID: string, checkpointIDToPlan: string): RestorePlan | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const manifold = loadManifest(held, checkpointIDToPlan, manifests);
    if (manifold.kind === "refused") return manifold;
    return buildPlan(held, manifold.manifest, ignore);
  };

  const restore = (sessionID: string, confirmation: RestoreConfirmation): RestoreReceipt | FilesRefusal => {
    const bound = bind(sessionID);
    if (bound.kind === "refused") return bound;
    const held = bound.binding;
    const manifold = loadManifest(held, confirmation.checkpointID, manifests);
    if (manifold.kind === "refused") return manifold;
    const fresh = buildPlan(held, manifold.manifest, ignore);
    if (fresh.kind === "refused") return fresh;
    if (confirmation.root !== fresh.root || confirmation.token !== fresh.token) {
      return refuse("stale-confirmation", "the confirmed restore no longer matches the files on disk; plan and confirm again");
    }
    const applied: string[] = [];
    const unchanged = fresh.items.filter((item) => item.action === "unchanged").map((item) => item.path);
    const kept = fresh.items.filter((item) => item.action !== "restore" && item.action !== "unchanged").map((item) => item.path);
    const restorable = fresh.items.filter((item) => item.action === "restore");
    for (let index = 0; index < restorable.length; index += 1) {
      const item = restorable[index];
      const target = resolveTarget(held, item.path);
      if (target.kind === "refused") {
        return partial(manifold.manifest.id, applied, unchanged, kept, restorable, index, target);
      }
      const drift = driftOf(item, target);
      if (drift !== null) {
        return partial(manifold.manifest.id, applied, unchanged, kept, restorable, index, refuse("concurrent-modification", item.path + " " + drift));
      }
      const written = applyItem(held, item, target.absolute, writeBytes);
      if (written !== null) {
        return partial(manifold.manifest.id, applied, unchanged, kept, restorable, index, written);
      }
      applied.push(item.path);
    }
    return { kind: "restored", checkpointID: manifold.manifest.id, applied: applied, unchanged: unchanged, kept: kept };
  };

  return {
    authorize: authorize,
    list: list,
    read: read,
    checkpoint: checkpoint,
    diff: diff,
    planRestore: planRestore,
    restore: restore,
  };
}

type LoadedManifest = { readonly kind: "loaded"; readonly manifest: CheckpointManifest };

function loadManifest(held: Binding, id: string, cache: Map<string, CheckpointManifest>): LoadedManifest | FilesRefusal {
  const cached = cache.get(id);
  if (cached !== undefined) return cached.root === held.root ? { kind: "loaded", manifest: cached } : refuse("outside-root", "checkpoint " + id + " belongs to another authorized directory");
  const file = path.join(held.shadowRoot, id, MANIFEST);
  if (!existsSync(file)) return refuse("unknown-checkpoint", "no checkpoint " + id + " is stored for this session");
  const parsed = parseManifest(JSON.parse(readFileSync(file, "utf8")));
  if (parsed.kind === "refused") return parsed;
  if (parsed.manifest.root !== held.root) return refuse("outside-root", "checkpoint " + id + " belongs to another authorized directory");
  cache.set(id, parsed.manifest);
  return { kind: "loaded", manifest: parsed.manifest };
}

function parseManifest(value: unknown): LoadedManifest | FilesRefusal {
  if (!isRecord(value)) return refuse("manifest-invalid", "a checkpoint manifest is not an object");
  if (value["version"] !== 1) return refuse("manifest-invalid", "a checkpoint manifest has an unsupported version");
  if (typeof value["id"] !== "string") return refuse("manifest-invalid", "a checkpoint manifest has no id");
  if (typeof value["root"] !== "string") return refuse("manifest-invalid", "a checkpoint manifest has no root");
  if (typeof value["createdAt"] !== "string") return refuse("manifest-invalid", "a checkpoint manifest has no createdAt");
  const scope = parseScope(value["scope"]);
  if (scope.kind === "refused") return scope;
  if (!Array.isArray(value["items"])) return refuse("manifest-invalid", "a checkpoint manifest has no item list");
  const items: CheckpointItem[] = [];
  for (const raw of value["items"]) {
    const item = parseItem(raw);
    if (item.kind === "refused") return item;
    items.push(item);
  }
  return {
    kind: "loaded",
    manifest: { version: 1, id: value["id"], root: value["root"], createdAt: value["createdAt"], scope: scope.scope, items: items },
  };
}

function parseScope(value: unknown): { readonly kind: "scope"; readonly scope: CheckpointScope } | FilesRefusal {
  if (!isRecord(value)) return refuse("manifest-invalid", "a checkpoint manifest has no scope");
  const scopePath = value["path"];
  const scopeKind = value["kind"];
  if (typeof scopePath !== "string") return refuse("manifest-invalid", "a checkpoint scope has no path");
  if (scopeKind !== "file" && scopeKind !== "directory") return refuse("manifest-invalid", "a checkpoint scope has an unknown kind");
  return { kind: "scope", scope: { path: scopePath, kind: scopeKind } };
}

function parseItem(value: unknown): CheckpointItem | FilesRefusal {
  if (!isRecord(value)) return refuse("manifest-invalid", "a checkpoint item is not an object");
  const itemPath = value["path"];
  const itemKind = value["kind"];
  if (typeof itemPath !== "string") return refuse("manifest-invalid", "a checkpoint item has no path");
  if (itemKind !== "file" && itemKind !== "directory" && itemKind !== "ignored" && itemKind !== "symlink" && itemKind !== "other") {
    return refuse("manifest-invalid", "a checkpoint item " + itemPath + " has an unknown kind");
  }
  const digest = value["digest"];
  const bytes = value["bytes"];
  const mode = value["mode"];
  if (digest !== null && typeof digest !== "string") return refuse("manifest-invalid", "a checkpoint item " + itemPath + " has an invalid digest");
  if (bytes !== null && typeof bytes !== "number") return refuse("manifest-invalid", "a checkpoint item " + itemPath + " has an invalid byte count");
  if (mode !== null && typeof mode !== "number") return refuse("manifest-invalid", "a checkpoint item " + itemPath + " has an invalid mode");
  return { path: itemPath, kind: itemKind, digest: digest, bytes: bytes, mode: mode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryOf(held: Binding, directory: string, name: string, prefix: string): FileEntry {
  const absolute = path.join(directory, name);
  const info = lstatSync(absolute);
  const kind: FileKind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  const real = kind === "symlink" ? realpathOrNull(absolute) : null;
  return {
    path: prefix === "" ? name : prefix + "/" + name,
    kind: kind,
    bytes: kind === "file" ? info.size : null,
    mode: info.mode & 0o777,
    escapes: kind === "symlink" && real !== null && !within(held.root, real),
  };
}

function captureDirectory(held: Binding, absolute: string, relative: string, items: CheckpointItem[], digests: Set<string>): FilesRefusal | { readonly kind: "captured" } {
  const names = readdirSync(absolute, { withFileTypes: true }).sort((first, second) => comparePaths(first.name, second.name));
  for (const dirent of names) {
    if (items.length >= MAX_CHECKPOINT_ENTRIES) return refuse("checkpoint-limit", "a checkpoint may not hold more than " + String(MAX_CHECKPOINT_ENTRIES) + " entries");
    const childPath = relative === "" ? dirent.name : relative + "/" + dirent.name;
    if (isIgnored(childPath)) {
      items.push({ path: childPath, kind: "ignored", digest: null, bytes: null, mode: null });
      continue;
    }
    const childAbsolute = path.join(absolute, dirent.name);
    const info = lstatSync(childAbsolute);
    if (info.isSymbolicLink()) {
      items.push({ path: childPath, kind: "symlink", digest: null, bytes: null, mode: null });
      continue;
    }
    if (info.isDirectory()) {
      items.push({ path: childPath, kind: "directory", digest: null, bytes: null, mode: info.mode & 0o777 });
      const nested = captureDirectory(held, childAbsolute, childPath, items, digests);
      if (nested.kind === "refused") return nested;
      continue;
    }
    if (!info.isFile()) {
      items.push({ path: childPath, kind: "other", digest: null, bytes: null, mode: info.mode & 0o777 });
      continue;
    }
    const captured = captureFile(held, childAbsolute, childPath, items, digests);
    if (captured.kind === "refused") return captured;
  }
  return { kind: "captured" };
}

function captureFile(held: Binding, absolute: string, relative: string, items: CheckpointItem[], digests: Set<string>): FilesRefusal | { readonly kind: "captured" } {
  const info = lstatSync(absolute);
  if (info.size > MAX_FILE_BYTES) {
    return refuse("file-too-large", relative + " is larger than the " + String(MAX_FILE_BYTES) + " byte capture limit");
  }
  const content = readFileSync(absolute);
  const digest = sha256Hex(content);
  const stored = storeObject(held, digest, content);
  if (stored !== null) return stored;
  digests.add(digest);
  items.push({ path: relative, kind: "file", digest: digest, bytes: content.byteLength, mode: info.mode & 0o777 });
  return { kind: "captured" };
}

function storeObject(held: Binding, digest: string, content: Uint8Array): FilesRefusal | null {
  const objects = path.join(held.shadowRoot, OBJECTS);
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const target = path.join(objects, digest);
  if (existsSync(target)) {
    const stored = readFileSync(target);
    if (sha256Hex(stored) === digest) return null;
    return refuse("checkpoint-unreadable", "the checkpoint store holds content that does not match its digest: " + digest);
  }
  writeAtomically(target, content, 0o600);
  return null;
}

function readObject(held: Binding, digest: string): Uint8Array | FilesRefusal {
  const target = path.join(held.shadowRoot, OBJECTS, digest);
  if (!existsSync(target)) return refuse("checkpoint-unreadable", "the checkpoint store is missing object " + digest);
  const stored = readFileSync(target);
  if (sha256Hex(stored) !== digest) return refuse("checkpoint-unreadable", "the checkpoint store holds content that does not match digest " + digest);
  return stored;
}

function compareManifest(held: Binding, manifest: CheckpointManifest, ignore: readonly string[]): { readonly kind: "compared"; readonly items: readonly DiffItem[] } | FilesRefusal {
  const known = new Map<string, CheckpointItem>();
  for (const item of manifest.items) known.set(item.path, item);
  const diskPaths: string[] = [];
  const walked: { readonly kind: "walked" } | FilesRefusal =
    manifest.scope.kind === "directory" ? walkDisk(held, manifest.scope.path, diskPaths, ignore) : { kind: "walked" };
  if (walked.kind === "refused") return walked;
  if (manifest.scope.kind === "file") diskPaths.push(manifest.scope.path);
  const items: DiffItem[] = [];
  const seen = new Set<string>();
  for (const diskPath of diskPaths) {
    if (seen.has(diskPath)) continue;
    seen.add(diskPath);
    const knownItem = known.get(diskPath);
    if (knownItem === undefined) {
      const added = describeAddition(held, diskPath, ignore);
      if (added.kind === "refused") return added;
      if (added.item !== null) items.push(added.item);
      continue;
    }
    const compared = compareItem(held, knownItem);
    if (compared.kind === "refused") return compared;
    items.push(compared.item);
  }
  for (const knownItem of manifest.items) {
    if (seen.has(knownItem.path)) continue;
    items.push(missingItem(knownItem));
  }
  return { kind: "compared", items: items.sort((first, second) => comparePaths(first.path, second.path)) };
}

function walkDisk(held: Binding, relative: string, out: string[], ignore: readonly string[]): { readonly kind: "walked" } | FilesRefusal {
  const target = resolveTarget(held, relative);
  if (target.kind === "refused") return target;
  if (!target.exists) return { kind: "walked" };
  const info = lstatSync(target.absolute);
  if (!info.isDirectory()) return { kind: "walked" };
  const names = readdirSync(target.absolute, { withFileTypes: true }).sort((first, second) => comparePaths(first.name, second.name));
  for (const dirent of names) {
    if (out.length >= MAX_CHECKPOINT_ENTRIES) return refuse("checkpoint-limit", "a checkpoint may not hold more than " + String(MAX_CHECKPOINT_ENTRIES) + " entries");
    const childPath = relative === "" ? dirent.name : relative + "/" + dirent.name;
    out.push(childPath);
    if (isIgnored(childPath, ignore)) continue;
    if (dirent.isDirectory()) {
      const nested = walkDisk(held, childPath, out, ignore);
      if (nested.kind === "refused") return nested;
    }
  }
  return { kind: "walked" };
}

function descriptorOf(path_: string): FileKind {
  const info = lstatSync(path_);
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function describeAddition(held: Binding, relative: string, ignore: readonly string[]): { readonly kind: "described"; readonly item: DiffItem | null } | FilesRefusal {
  const target = resolveTarget(held, relative);
  if (target.kind === "refused") return target;
  if (!target.exists) return { kind: "described", item: null };
  const kind = descriptorOf(target.absolute);
  if (isIgnored(relative, ignore)) {
    return { kind: "described", item: { path: relative, kind: "other", status: "ignored", checkpointDigest: null, diskDigest: null, bytes: null } };
  }
  if (kind !== "file") {
    return { kind: "described", item: { path: relative, kind: kind, status: "added", checkpointDigest: null, diskDigest: null, bytes: null } };
  }
  const content = readFileSync(target.absolute);
  if (content.byteLength > MAX_FILE_BYTES) return refuse("file-too-large", relative + " is larger than the " + String(MAX_FILE_BYTES) + " byte capture limit");
  return {
    kind: "described",
    item: { path: relative, kind: "file", status: "added", checkpointDigest: null, diskDigest: sha256Hex(content), bytes: content.byteLength },
  };
}

function compareItem(held: Binding, known: CheckpointItem): { readonly kind: "compared"; readonly item: DiffItem } | FilesRefusal {
  if (known.kind === "ignored") {
    return { kind: "compared", item: { path: known.path, kind: "other", status: "ignored", checkpointDigest: null, diskDigest: null, bytes: null } };
  }
  if (known.kind === "symlink" || known.kind === "other") {
    return { kind: "compared", item: { path: known.path, kind: "symlink", status: "skipped", checkpointDigest: null, diskDigest: null, bytes: null } };
  }
  const target = resolveTarget(held, known.path);
  if (target.kind === "refused") return target;
  if (!target.exists) return { kind: "compared", item: missingItem(known) };
  const info = lstatSync(target.absolute);
  if (known.kind === "directory") {
    const present = info.isDirectory();
    return {
      kind: "compared",
      item: {
        path: known.path,
        kind: "directory",
        status: present ? "unchanged" : "modified",
        checkpointDigest: null,
        diskDigest: null,
        bytes: null,
      },
    };
  }
  if (!info.isFile()) {
    return { kind: "compared", item: { path: known.path, kind: "file", status: "modified", checkpointDigest: known.digest, diskDigest: null, bytes: null } };
  }
  if (info.size > MAX_FILE_BYTES) return refuse("file-too-large", known.path + " is larger than the " + String(MAX_FILE_BYTES) + " byte capture limit");
  const diskDigest = sha256Hex(readFileSync(target.absolute));
  return {
    kind: "compared",
    item: {
      path: known.path,
      kind: "file",
      status: diskDigest === known.digest ? "unchanged" : "modified",
      checkpointDigest: known.digest,
      diskDigest: diskDigest,
      bytes: info.size,
    },
  };
}

function missingItem(known: CheckpointItem): DiffItem {
  if (known.kind === "directory") {
    return { path: known.path, kind: "directory", status: "removed", checkpointDigest: null, diskDigest: null, bytes: null };
  }
  if (known.kind === "file") {
    return { path: known.path, kind: "file", status: "removed", checkpointDigest: known.digest, diskDigest: null, bytes: known.bytes };
  }
  return { path: known.path, kind: "other", status: "skipped", checkpointDigest: null, diskDigest: null, bytes: null };
}

function buildPlan(held: Binding, manifest: CheckpointManifest, ignore: readonly string[]): RestorePlan | FilesRefusal {
  const compared = compareManifest(held, manifest, ignore);
  if (compared.kind === "refused") return compared;
  const known = new Map<string, CheckpointItem>();
  for (const item of manifest.items) known.set(item.path, item);
  const items: RestoreItem[] = compared.items.map((item) => {
    const source = known.get(item.path);
    if (item.status === "modified" || item.status === "removed") {
      return {
        path: item.path,
        action: "restore",
        kind: item.kind === "directory" ? "directory" : "file",
        expectedDigest: item.diskDigest,
        expectedAbsent: item.diskDigest === null && item.status === "removed",
        checkpointDigest: item.checkpointDigest,
        bytes: source === undefined ? null : source.bytes,
        mode: source === undefined ? null : source.mode,
      };
    }
    if (item.status === "unchanged") {
      return {
        path: item.path,
        action: "unchanged",
        kind: item.kind === "directory" ? "directory" : "file",
        expectedDigest: item.diskDigest,
        expectedAbsent: false,
        checkpointDigest: item.checkpointDigest,
        bytes: item.bytes,
        mode: source === undefined ? null : source.mode,
      };
    }
    if (item.status === "ignored") {
      return { path: item.path, action: "skip-ignored", kind: "other", expectedDigest: null, expectedAbsent: false, checkpointDigest: null, bytes: null, mode: null };
    }
    if (item.status === "added") {
      return {
        path: item.path,
        action: "keep-added",
        kind: item.kind === "directory" ? "directory" : item.kind === "file" ? "file" : "other",
        expectedDigest: item.diskDigest,
        expectedAbsent: false,
        checkpointDigest: null,
        bytes: item.bytes,
        mode: null,
      };
    }
    return { path: item.path, action: "skip-symlink", kind: "other", expectedDigest: null, expectedAbsent: false, checkpointDigest: null, bytes: null, mode: null };
  });
  const restorable = items.filter((item) => item.action === "restore").length;
  return { kind: "plan", checkpointID: manifest.id, root: held.root, token: planToken(items), items: items, restorable: restorable };
}

function driftOf(item: RestoreItem, target: ResolvedTarget): string | null {
  if (item.expectedAbsent) {
    return target.exists ? "appeared after the restore was confirmed" : null;
  }
  if (!target.exists) return "disappeared after the restore was confirmed";
  const info = lstatSync(target.absolute);
  if (item.kind === "directory") return info.isDirectory() ? null : "is no longer a directory";
  if (!info.isFile()) return "is no longer a regular file";
  if (info.size > MAX_FILE_BYTES) return "grew past the capture limit after the restore was confirmed";
  const digest = sha256Hex(readFileSync(target.absolute));
  return digest === item.expectedDigest ? null : "changed after the restore was confirmed";
}

function applyItem(held: Binding, item: RestoreItem, absolute: string, writeBytes: WriteBytes): FilesRefusal | null {
  try {
    if (item.kind === "directory") {
      mkdirSync(absolute, { recursive: false, mode: item.mode ?? 0o700 });
      if (item.mode !== null) chmodSync(absolute, item.mode);
      return null;
    }
    if (item.checkpointDigest === null) return refuse("checkpoint-unreadable", "checkpoint " + item.path + " has no captured content");
    const content = readObject(held, item.checkpointDigest);
    if (content instanceof Uint8Array) {
      writeBytes(absolute, content, item.mode ?? 0o600);
      return null;
    }
    return content;
  } catch (error) {
    return refuse("restore-failed", "writing " + item.path + " failed: " + messageOf(error));
  }
}

function partial(
  checkpointIDToReport: string,
  applied: readonly string[],
  unchanged: readonly string[],
  kept: readonly string[],
  restorable: readonly RestoreItem[],
  failedIndex: number,
  failure: FilesRefusal,
): RestoreReceipt {
  return {
    kind: "partial",
    checkpointID: checkpointIDToReport,
    applied: applied,
    unchanged: unchanged,
    kept: kept,
    pending: restorable.slice(failedIndex).map((item) => item.path),
    failed: { path: restorable[failedIndex].path, code: failure.code, message: failure.message },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveTarget(held: Binding, relative: string): ResolvedTarget | FilesRefusal {
  const checked = checkRelative(relative);
  if (checked.kind === "refused") return checked;
  const absolute = checked.path === "" ? held.root : path.join(held.root, checked.path);
  const real = realpathOrNull(absolute);
  if (real !== null) {
    if (!within(held.root, real)) return refuse("outside-root", checked.path + " resolves outside the authorized directory");
    return { kind: "resolved", path: checked.path, absolute: real, exists: true };
  }
  const realParent = realpathOrNull(path.dirname(absolute));
  if (realParent === null) return refuse("path-missing", "no part of " + checked.path + " exists under the authorized directory");
  if (!within(held.root, realParent)) return refuse("outside-root", checked.path + " resolves outside the authorized directory");
  return { kind: "resolved", path: checked.path, absolute: path.join(realParent, path.basename(absolute)), exists: false };
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function checkpointID(index: number): string {
  return "checkpoint_" + String(index).padStart(3, "0");
}

function nextCheckpointNumber(held: Binding, current: number): number {
  let next = current + 1;
  while (existsSync(path.join(held.shadowRoot, checkpointID(next)))) next += 1;
  return next;
}

function writeAtomically(target: string, bytes: Uint8Array, mode: number): void {
  const temp = path.join(path.dirname(target), ".bridge-" + randomUUID() + ".tmp");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    closeSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* the descriptor was already closed by the failing write */
    }
    try {
      unlinkSync(temp);
    } catch {
      /* the temporary file was never created or is already gone */
    }
    throw error;
  }
  try {
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temporary file is already gone */
    }
    throw error;
  }
}
