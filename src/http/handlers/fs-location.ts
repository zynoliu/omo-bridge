import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { gitRead } from "../../git";

const JSON_CONTENT_TYPE = "application/json";

export const MAX_FIND_RESULTS = 100;

export type FileEntryType = "file" | "directory";

// `FileSystem.Entry` (`packages/schema/src/filesystem.ts:18`) is exactly `{path, type}` and the TUI
// decodes those two keys, so a `name` or `size` here would be an undeclared field on the wire.
export type FileEntry = {
  path: string;
  type: FileEntryType;
};

export type ProjectInfo = {
  id: string;
  directory: string;
  canonical: string;
};

export type ProjectTime = {
  created: number;
  updated: number;
  active: number;
  archived?: number;
};

/** One row of GET /api/project: the TUI decodes it as `Project.Info` (`packages/schema/src/project.ts`). */
export type PublicProject = {
  id: string;
  canonical: string;
  time: ProjectTime;
  sandboxes: string[];
};

export type LocationPublicInfo = {
  directory: string;
  project: ProjectInfo;
};

export type FileDiff = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

function errorResponse(status: number, tag: string, message: string): Response {
  return jsonResponse(status, { _tag: tag, message });
}

function canonicalPath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

export function projectIdFor(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function locationInfo(directory: string): LocationPublicInfo {
  const canonical = canonicalPath(directory);
  return {
    directory,
    project: { id: projectIdFor(canonical), directory, canonical },
  };
}

// An enveloped response carries `Location.PublicRef` as its `location` — `directory` and nothing more
// (`packages/schema/src/location.ts:10`, `Location.response` at :37). `Location.PublicInfo`, which
// also carries the project, is the bare body of GET /api/location only.
export type LocationPublicRef = { directory: string };

export function locationRef(directory: string): LocationPublicRef {
  return { directory };
}

// Project.Time values are epoch millis, so read them from the directory itself instead of inventing
// one shared clock value per response. A filesystem without birth times falls back to its mtime.
function projectTimeOf(canonical: string): ProjectTime {
  const fallback = Date.now();
  let stats;
  try {
    stats = statSync(canonical);
  } catch {
    return { created: fallback, updated: fallback, active: fallback };
  }
  const updated = Math.max(0, Math.trunc(stats.mtimeMs));
  const born = Math.max(0, Math.trunc(stats.birthtimeMs));
  const active = updated === 0 ? fallback : updated;
  return { created: born === 0 ? active : born, updated: active, active };
}

export function publicProject(directory: string): PublicProject {
  const info = locationInfo(directory);
  return {
    id: info.project.id,
    canonical: info.project.canonical,
    time: projectTimeOf(info.project.canonical),
    sandboxes: [],
  };
}

function firstNonEmpty(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value !== null && value.trim().length > 0) return value.trim();
  }
  return null;
}

function requestedDirectory(url: URL, acceptPathAlias: boolean): string {
  const raw = firstNonEmpty(
    url.searchParams.get("location[directory]"),
    acceptPathAlias ? url.searchParams.get("path") : null,
  );
  if (raw === null) return process.cwd();
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

function relativePath(root: string, absolute: string): string {
  return relative(root, absolute).split("\\").join("/");
}

function entryFor(root: string, directory: string, dirent: Dirent): FileEntry {
  const absolute = join(directory, dirent.name);
  const path = relativePath(root, absolute);
  try {
    return { path, type: statSync(absolute).isDirectory() ? "directory" : "file" };
  } catch {
    return { path, type: "file" };
  }
}

function byName(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function directoryError(directory: string): Response | null {
  let stats;
  try {
    stats = statSync(directory);
  } catch {
    return errorResponse(404, "FileNotFoundError", `directory not found: ${directory}`);
  }
  if (!stats.isDirectory()) {
    return errorResponse(400, "InvalidRequestError", `not a directory: ${directory}`);
  }
  return null;
}

function readDirectory(directory: string): { ok: true; entries: FileEntry[] } | { ok: false; response: Response } {
  const failure = directoryError(directory);
  if (failure !== null) return { ok: false, response: failure };
  try {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort(byName)
      .map((dirent) => entryFor(directory, directory, dirent));
    return { ok: true, entries };
  } catch {
    return { ok: false, response: errorResponse(404, "FileNotFoundError", `directory not readable: ${directory}`) };
  }
}

function findEntries(root: string, query: string, limit: number): FileEntry[] {
  const needle = query.toLowerCase();
  const found: FileEntry[] = [];
  const pending: string[] = [root];
  while (pending.length > 0 && found.length < limit) {
    const current = pending.shift()!;
    let dirents: Dirent[];
    try {
      dirents = readdirSync(current, { withFileTypes: true }).sort(byName);
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (found.length >= limit) break;
      if (dirent.name === ".git") continue;
      const entry = entryFor(root, current, dirent);
      if (dirent.name.toLowerCase().includes(needle)) found.push(entry);
      if (dirent.isDirectory()) pending.push(join(current, dirent.name));
    }
  }
  return found;
}

function readLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim().length === 0) return MAX_FIND_RESULTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return Math.min(value, MAX_FIND_RESULTS);
}

// `FileDiff.Info` (`packages/schema/src/file-diff.ts`) requires the patch text and a status, and the
// TUI renders both (`packages/tui/src/feature-plugins/system/diff-viewer.tsx:67-74`). `git diff
// --numstat` cannot supply either, so the diff is parsed from the unified patch instead.
function diffFile(header: string): string {
  const marker = header.lastIndexOf(" b/");
  return marker < 0 ? header.slice("diff --git a/".length) : header.slice(marker + " b/".length);
}

function parseUnifiedDiff(output: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  let current: FileDiff | undefined;
  let patch: string[] = [];
  let inHunks = false;

  const flush = (): void => {
    if (current !== undefined) {
      current.patch = patch.join("\n");
      diffs.push(current);
    }
    current = undefined;
    patch = [];
    inHunks = false;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { file: diffFile(line), patch: "", additions: 0, deletions: 0, status: "modified" };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("@@")) {
      inHunks = true;
      patch.push(line);
      continue;
    }
    if (!inHunks) continue;
    patch.push(line);
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  flush();
  return diffs;
}

export async function handleFsList(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, true);
  const listed = readDirectory(directory);
  if (!listed.ok) return listed.response;
  return jsonResponse(200, { location: locationRef(directory), data: listed.entries });
}

export async function handleFsFind(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const query = url.searchParams.get("query");
  if (query === null) {
    return errorResponse(400, "InvalidRequestError", "query is required");
  }
  const limit = readLimit(url);
  if (limit === null) {
    return errorResponse(400, "InvalidRequestError", "limit must be a positive integer");
  }
  const failure = directoryError(directory);
  if (failure !== null) return failure;
  return jsonResponse(200, { location: locationRef(directory), data: findEntries(directory, query, limit) });
}

// `location.get` declares `success: Location.PublicInfo` with no `Location.response(...)` wrapper
// (`packages/protocol/src/groups/location.ts:36`), and the client reads the body as the location
// itself: `setDefaultLocation({ directory: location.directory })`
// (`packages/client/src/solid/data.ts:2065-2071`). Wrapping it as `{location}` made that directory
// undefined and crashed the prompt's location memo. Unlike fs.list/vcs.get, this body is bare.
export async function handleLocationGet(_request: Request, url: URL): Promise<Response> {
  return jsonResponse(200, locationInfo(requestedDirectory(url, false)));
}

export async function handleProjectList(_request: Request, _url: URL): Promise<Response> {
  return jsonResponse(200, [publicProject(process.cwd())]);
}

export async function handleConfigGet(_request: Request, _url: URL): Promise<Response> {
  return jsonResponse(200, []);
}

async function repoDefaultBranch(directory: string): Promise<string | undefined> {
  const remote = (await gitRead(directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (remote !== undefined && remote.length > 0) {
    return remote.startsWith("origin/") ? remote.slice("origin/".length) : remote;
  }
  const configured = (await gitRead(directory, ["config", "--get", "init.defaultBranch"]))?.trim();
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}

// Vcs.Info.branch is a required struct, never null: an empty object is the valid "no branch" value.
async function vcsBranch(directory: string): Promise<{ current?: string; default?: string }> {
  // symbolic-ref reports a branch name in an unborn repository, where rev-parse only answers HEAD.
  const symbolic = (await gitRead(directory, ["symbolic-ref", "--short", "HEAD"]))?.trim();
  const branch =
    symbolic !== undefined && symbolic.length > 0
      ? symbolic
      : (await gitRead(directory, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  if (branch === undefined || branch.length === 0 || branch === "HEAD") return {};
  return { current: branch, default: (await repoDefaultBranch(directory)) ?? branch };
}

export async function handleVcsGet(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  return jsonResponse(200, {
    location: locationRef(directory),
    data: { branch: await vcsBranch(directory) },
  });
}

export async function handleVcsBase(_request: Request, url: URL): Promise<Response> {
  return jsonResponse(200, { location: locationRef(requestedDirectory(url, false)), data: null });
}

// `fs.read` declares `/api/fs/read/*` with a `LocationQuery`; the fork's client puts the file path in
// that wildcard tail (`packages/client/src/promise/generated/client.ts`, `encodePath(input.path)`).
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** The read is confined to the requested location, matching the endpoint's documented containment. */
export async function handleFsRead(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  // The router's wildcard captures the tail, but handlers are registered as (request, url); the
  // prefix is fixed, so the file path is everything after it.
  const prefix = "/api/fs/read/";
  const encoded = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  const raw = encoded
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/")
    .trim();
  if (raw.length === 0) {
    return errorResponse(400, "InvalidRequestError", "a file path is required");
  }
  const target = isAbsolute(raw) ? resolve(raw) : resolve(directory, raw);
  const inside = relative(directory, target);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return errorResponse(400, "InvalidRequestError", `path escapes the requested location: ${raw}`);
  }
  try {
    if (!statSync(target).isFile()) {
      return errorResponse(400, "InvalidRequestError", `not a file: ${raw}`);
    }
    // A symlink inside the location can still point outside it; confine the real file too.
    const real = realpathSync(target);
    const realInside = relative(realpathSync(directory), real);
    if (realInside.startsWith("..") || isAbsolute(realInside)) {
      return errorResponse(400, "InvalidRequestError", `path escapes the requested location: ${raw}`);
    }
    const bytes = readFileSync(real);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
  } catch {
    return errorResponse(404, "FileNotFoundError", `file not found: ${raw}`);
  }
}

// `vcs.status` rows are `Vcs.FileStatus`: `{file, additions, deletions, status}`.
function statusFromPorcelain(code: string): "added" | "deleted" | "modified" {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

async function numstat(directory: string, cached: boolean): Promise<Map<string, { additions: number; deletions: number }>> {
  const args = ["diff", "--numstat", ...(cached ? ["--cached"] : [])];
  const output = await gitRead(directory, args);
  const counts = new Map<string, { additions: number; deletions: number }>();
  if (output === null) return counts;
  for (const line of output.split("\n")) {
    const [added, deleted, ...file] = line.split("\t");
    if (added === undefined || deleted === undefined || file.length === 0) continue;
    const path = file.join("\t");
    // A binary file reports `-` for both counts; zero is the honest count there.
    counts.set(path, {
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
    });
  }
  return counts;
}

export async function handleVcsStatus(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const output = await gitRead(directory, ["status", "--porcelain=v1"]);
  if (output === null) {
    return jsonResponse(200, { location: locationRef(directory), data: [] });
  }
  const [unstaged, staged] = await Promise.all([numstat(directory, false), numstat(directory, true)]);
  const data: Array<{ file: string; additions: number; deletions: number; status: string }> = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).split(" -> ").at(-1)!;
    const counts = unstaged.get(path) ?? staged.get(path) ?? { additions: 0, deletions: 0 };
    data.push({ file: path, additions: counts.additions, deletions: counts.deletions, status: statusFromPorcelain(code) });
  }
  return jsonResponse(200, { location: locationRef(directory), data });
}

export async function handleVcsBranch(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const output = await gitRead(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  const search = url.searchParams.get("search")?.toLowerCase() ?? "";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    return errorResponse(400, "InvalidRequestError", "limit must be a positive integer");
  }
  const branches = (output ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.endsWith("/HEAD"))
    .filter((name) => search.length === 0 || name.toLowerCase().includes(search));
  return jsonResponse(200, { location: locationRef(directory), data: [...new Set(branches)].slice(0, limit) });
}

export async function handleLocationReload(_request: Request, _url: URL): Promise<Response> {
  // The bridge watches no location service state, so a reload has nothing to reconcile.
  return new Response(null, { status: 204 });
}

export async function handleVcsDiff(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const output = await gitRead(directory, ["diff", "--no-color"]);
  return jsonResponse(200, {
    location: locationRef(directory),
    data: output === null ? [] : parseUnifiedDiff(output),
  });
}
