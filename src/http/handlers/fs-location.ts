import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gitRead } from "../../git";

const JSON_CONTENT_TYPE = "application/json";

export const MAX_FIND_RESULTS = 100;

export type FileEntryType = "file" | "directory";

export type FileEntry = {
  name: string;
  path: string;
  type: FileEntryType;
  size?: number;
};

export type ProjectInfo = {
  id: string;
  directory: string;
  canonical: string;
};

export type LocationPublicInfo = {
  directory: string;
  project: ProjectInfo;
};

export type FileDiff = {
  file: string;
  additions: number;
  deletions: number;
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
    const stats = statSync(absolute);
    if (stats.isDirectory()) return { name: dirent.name, path, type: "directory" };
    return { name: dirent.name, path, type: "file", size: stats.size };
  } catch {
    return { name: dirent.name, path, type: "file" };
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

function readCount(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseNumstat(output: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const file = parts.slice(2).join("\t");
    diffs.push({ file, additions: readCount(parts[0]), deletions: readCount(parts[1]) });
  }
  return diffs;
}

export async function handleFsList(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, true);
  const listed = readDirectory(directory);
  if (!listed.ok) return listed.response;
  return jsonResponse(200, { location: locationInfo(directory), data: listed.entries });
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
  return jsonResponse(200, { location: locationInfo(directory), data: findEntries(directory, query, limit) });
}

export async function handleLocationGet(_request: Request, url: URL): Promise<Response> {
  return jsonResponse(200, { location: locationInfo(requestedDirectory(url, false)) });
}

export async function handleProjectList(_request: Request, _url: URL): Promise<Response> {
  return jsonResponse(200, [locationInfo(process.cwd()).project]);
}

export async function handleConfigGet(_request: Request, _url: URL): Promise<Response> {
  return jsonResponse(200, []);
}

export async function handleVcsGet(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const output = await gitRead(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = output?.trim();
  return jsonResponse(200, {
    location: locationInfo(directory),
    data: { branch: branch !== undefined && branch.length > 0 ? branch : null },
  });
}

export async function handleVcsBase(_request: Request, url: URL): Promise<Response> {
  return jsonResponse(200, { location: locationInfo(requestedDirectory(url, false)), data: null });
}

export async function handleVcsDiff(_request: Request, url: URL): Promise<Response> {
  const directory = requestedDirectory(url, false);
  const output = await gitRead(directory, ["diff", "--numstat"]);
  return jsonResponse(200, {
    location: locationInfo(directory),
    data: output === null ? [] : parseNumstat(output),
  });
}
