/*
 * Model for the same-machine file surface: listing, reading, shadow checkpoints, diffs and a restore that
 * runs only on a plan the caller confirmed.
 *
 * A checkpoint is a private, content-addressed object store beside the authorized directory. It keeps the
 * path, the content digest, the ignore decision and the mode of every captured entry. Nothing here writes
 * to Git - no index entry, no commit, no ref - and this mechanism is not OpenCode Snapshot and must never
 * be described as equivalent to it: OpenCode captures through the project's own Git object database,
 * while this store never enters the user's repository at all.
 */

import path from "node:path";

export type FilesRefusalCode =
  | "invalid-session"
  | "invalid-root"
  | "root-unavailable"
  | "root-reaches-home"
  | "invalid-shadow"
  | "shadow-reaches-home"
  | "shadow-overlaps-root"
  | "already-authorized"
  | "unbound-session"
  | "path-escape"
  | "path-missing"
  | "outside-root"
  | "not-a-file"
  | "not-a-directory"
  | "file-too-large"
  | "checkpoint-limit"
  | "checkpoint-unreadable"
  | "unknown-checkpoint"
  | "manifest-invalid"
  | "stale-confirmation"
  | "concurrent-modification"
  | "restore-failed";

export type FilesRefusal = {
  readonly kind: "refused";
  readonly code: FilesRefusalCode;
  readonly message: string;
};

export function refuse(code: FilesRefusalCode, message: string): FilesRefusal {
  return { kind: "refused", code: code, message: message };
}

/* A single capture is bounded: nothing here walks an unbounded tree or reads a file it never finishes. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CHECKPOINT_ENTRIES = 2000;
export const MAX_LIST_ENTRIES = 500;

/* Product-owned ignore rules. They decide what a checkpoint skips; the user's own ignore files are never read. */
export const DEFAULT_IGNORED = [".git", ".hg", ".svn", "node_modules", ".DS_Store"] as const;

export type FileKind = "file" | "directory" | "symlink" | "other";

export type FileEntry = {
  readonly path: string;
  readonly kind: FileKind;
  readonly bytes: number | null;
  readonly mode: number | null;
  /* a symlink whose target resolves outside the authorized directory: it is reported, never followed */
  readonly escapes: boolean;
};

export type ListingReceipt = {
  readonly kind: "listed";
  readonly root: string;
  readonly directory: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
};

export type ReadReceipt = {
  readonly kind: "read";
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly mode: number;
  readonly content: Uint8Array;
};

export type AuthorizedReceipt = {
  readonly kind: "authorized";
  readonly sessionID: string;
  readonly root: string;
  readonly shadowRoot: string;
};

export type CheckpointItemKind = "file" | "directory" | "ignored" | "symlink" | "other";

export type CheckpointItem = {
  readonly path: string;
  readonly kind: CheckpointItemKind;
  readonly digest: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
};

export type CheckpointScope = {
  readonly path: string;
  readonly kind: "file" | "directory";
};

export type CheckpointManifest = {
  readonly version: 1;
  readonly id: string;
  readonly root: string;
  readonly createdAt: string;
  readonly scope: CheckpointScope;
  readonly items: readonly CheckpointItem[];
};

export type CheckpointReceipt = {
  readonly kind: "checkpointed";
  readonly manifest: CheckpointManifest;
  readonly objects: number;
};

export type DiffStatus = "unchanged" | "modified" | "removed" | "added" | "ignored" | "skipped";

export type DiffItem = {
  readonly path: string;
  readonly kind: FileKind;
  readonly status: DiffStatus;
  readonly checkpointDigest: string | null;
  readonly diskDigest: string | null;
  readonly bytes: number | null;
};

export type DiffReceipt = {
  readonly kind: "diff";
  readonly checkpointID: string;
  readonly root: string;
  readonly items: readonly DiffItem[];
  readonly changed: number;
};

export type RestoreAction = "restore" | "unchanged" | "skip-ignored" | "skip-symlink" | "keep-added";

export type RestoreItem = {
  readonly path: string;
  readonly action: RestoreAction;
  readonly kind: "file" | "directory" | "other";
  /* the disk state the caller reviewed; restore writes only while this still holds */
  readonly expectedDigest: string | null;
  readonly expectedAbsent: boolean;
  readonly checkpointDigest: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
};

export type RestorePlan = {
  readonly kind: "plan";
  readonly checkpointID: string;
  readonly root: string;
  readonly token: string;
  readonly items: readonly RestoreItem[];
  readonly restorable: number;
};

export type RestoreConfirmation = {
  readonly checkpointID: string;
  readonly root: string;
  readonly token: string;
};

export type RestoreFailure = {
  readonly path: string;
  readonly code: FilesRefusalCode;
  readonly message: string;
};

export type RestoreReceipt =
  | {
      readonly kind: "restored";
      readonly checkpointID: string;
      readonly applied: readonly string[];
      readonly unchanged: readonly string[];
      readonly kept: readonly string[];
    }
  | {
      readonly kind: "partial";
      readonly checkpointID: string;
      readonly applied: readonly string[];
      readonly unchanged: readonly string[];
      readonly kept: readonly string[];
      readonly pending: readonly string[];
      readonly failed: RestoreFailure;
    };

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Path ordering that does not depend on the ambient locale. */
export function comparePaths(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

export function within(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(".." + path.sep);
}

export type RelativePath = { readonly kind: "relative"; readonly path: string };

/**
 * A relative path is checked lexically before the filesystem is touched: an absolute path, a NUL byte or a
 * `..` segment is refused, so no later resolution step can be handed a path that climbs out. The empty
 * result names the authorized directory itself.
 */
export function checkRelative(relative: string): RelativePath | FilesRefusal {
  if (typeof relative !== "string" || relative.includes("\u0000")) {
    return refuse("path-escape", "a file path must be a string without NUL bytes");
  }
  if (path.isAbsolute(relative)) {
    return refuse("path-escape", "a file path is always relative to the authorized directory: " + relative);
  }
  const segments = relative.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return refuse("path-escape", "a file path may not contain a parent segment: " + relative);
  }
  return { kind: "relative", path: segments.join("/") };
}

export function isIgnored(relative: string, extra: readonly string[] = []): boolean {
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const patterns = [...DEFAULT_IGNORED, ...extra];
  return segments.some((segment) => patterns.includes(segment));
}

/**
 * The confirmation token covers every item the caller reviewed - its path, action, expected disk state and
 * checkpoint content - so a plan token matches only the exact disk state it was produced from.
 */
export function planToken(items: readonly RestoreItem[]): string {
  const lines = [...items].sort((first, second) => comparePaths(first.path, second.path)).map((item) => {
    const fields = [
      item.path,
      item.action,
      item.kind,
      item.expectedDigest ?? "-",
      item.expectedAbsent ? "absent" : "present",
      item.checkpointDigest ?? "-",
      item.bytes === null ? "-" : String(item.bytes),
      item.mode === null ? "-" : item.mode.toString(8),
    ];
    return fields.join("\t");
  });
  return sha256Hex(new TextEncoder().encode(lines.join("\n")));
}
