import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { refuse, within } from "./state.ts";
import type { FilesRefusal } from "./state.ts";

export type FilesSpec = {
  readonly sessionID: string;
  readonly root: string;
  readonly shadowRoot: string;
};

export type AcceptedFilesSpec = {
  readonly kind: "accepted";
  readonly sessionID: string;
  readonly root: string;
  readonly shadowRoot: string;
};

export type FilesSpecCheck = AcceptedFilesSpec | FilesRefusal;

/**
 * Accepts one directory a session explicitly authorized, plus the product-owned shadow store that keeps its
 * checkpoints. The authorized directory is canonicalized once here, so every later containment check compares
 * real paths. A directory at or above the ambient home is refused, and the shadow store may not live inside
 * the user's home or overlap the authorized directory in either direction - otherwise a capture would end up
 * inside the tree it is capturing, or beside the user's real files.
 */
export function checkFilesSpec(spec: FilesSpec, homeDirectory: string): FilesSpecCheck {
  if (typeof spec.sessionID !== "string" || spec.sessionID.trim().length === 0) {
    return refuse("invalid-session", "a file surface must be bound to a non-empty session id");
  }
  if (typeof spec.root !== "string" || !path.isAbsolute(spec.root)) {
    return refuse("invalid-root", "the authorized directory must be an absolute path");
  }
  const root = resolveDirectory(spec.root);
  if (root === null) return refuse("root-unavailable", "the authorized directory is not an existing directory: " + spec.root);
  const home = resolveDirectory(homeDirectory) ?? homeDirectory;
  if (within(root, home)) {
    return refuse("root-reaches-home", "the authorized directory is the ambient home directory or contains it");
  }
  if (typeof spec.shadowRoot !== "string" || !path.isAbsolute(spec.shadowRoot)) {
    return refuse("invalid-shadow", "the checkpoint store must be an absolute path");
  }
  const shadow = resolveShadow(spec.shadowRoot);
  if (shadow.kind === "refused") return shadow;
  if (within(home, shadow.path)) {
    return refuse("shadow-reaches-home", "the checkpoint store may not live in the ambient home directory");
  }
  if (within(root, shadow.path) || within(shadow.path, root)) {
    return refuse("shadow-overlaps-root", "the checkpoint store and the authorized directory may not contain each other");
  }
  return { kind: "accepted", sessionID: spec.sessionID, root: root, shadowRoot: shadow.path };
}

type ResolvedDirectory = { readonly kind: "resolved"; readonly path: string };

function resolveDirectory(target: string): string | null {
  try {
    if (!lstatSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * An existing store must be a real directory, never a symlink. A missing one is allowed only below an
 * existing parent, so the store can be created later without ever creating a parent tree of its own.
 */
function resolveShadow(target: string): ResolvedDirectory | FilesRefusal {
  try {
    const held = lstatSync(target);
    if (held.isSymbolicLink()) return refuse("invalid-shadow", "the checkpoint store may not be a symlink: " + target);
    if (!held.isDirectory()) return refuse("invalid-shadow", "the checkpoint store is not a directory: " + target);
    return { kind: "resolved", path: realpathSync(target) };
  } catch {
    const parent = path.dirname(target);
    const resolvedParent = resolveDirectory(parent);
    if (resolvedParent === null) {
      return refuse("invalid-shadow", "the checkpoint store must be created below an existing directory: " + target);
    }
    return { kind: "resolved", path: path.join(resolvedParent, path.basename(target)) };
  }
}
