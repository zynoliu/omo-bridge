import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponse } from "../../src/contract/validate";
import { gitRead } from "../../src/git";
import {
  handleConfigGet,
  handleFsFind,
  handleFsList,
  handleLocationGet,
  handleProjectList,
  handleVcsBase,
  handleVcsDiff,
  handleVcsGet,
  MAX_FIND_RESULTS,
  type FileDiff,
  type FileEntry,
  type LocationPublicInfo,
  type PublicProject,
} from "../../src/http/handlers/fs-location";

let base: string;
let repo: string;
let plain: string;

const BULK_COUNT = 105;

function run(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function request(path: string, params: Record<string, string> = {}): Request {
  const url = new URL(`http://bridge.test${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url);
}

function requestUrl(path: string, params: Record<string, string> = {}): URL {
  return new URL(request(path, params).url);
}

function projectId(directory: string): string {
  return createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 16);
}

type ListBody = { location: LocationPublicInfo; data: FileEntry[] };

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "omo-bridge-fs-"));
  repo = join(base, "repo");
  plain = join(base, "plain");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "nested", "deep"), { recursive: true });
  mkdirSync(join(repo, "empty"), { recursive: true });
  mkdirSync(join(repo, "bulk"), { recursive: true });
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(repo, "alpha.txt"), "alpha\n");
  writeFileSync(join(repo, "src", "gamma.ts"), "export const gamma = 1;\n");
  writeFileSync(join(repo, "nested", "deep", "delta.md"), "# delta\n");
  for (let index = 0; index < BULK_COUNT; index += 1) {
    writeFileSync(join(repo, "bulk", `bulk-${String(index).padStart(3, "0")}.txt`), "x\n");
  }
  run(["git", "init", "-q", "-b", "main"], repo);
  run(["git", "add", "-A"], repo);
  run(["git", "-c", "user.email=bridge@example.com", "-c", "user.name=Bridge", "commit", "-q", "-m", "init"], repo);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("handleFsList", () => {
  test("lists direct children with the location envelope", async () => {
    const response = await handleFsList(request("/api/fs/list"), requestUrl("/api/fs/list", { "location[directory]": repo }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as ListBody;
    expect(body.location.directory).toBe(repo);
    expect(body.location.project).toEqual({
      id: projectId(repo),
      directory: repo,
      canonical: realpathSync(repo),
    });
    expect(body.data.map((entry) => entry.name)).toEqual([".git", "alpha.txt", "bulk", "empty", "nested", "src"]);

    const alpha = body.data.find((entry) => entry.name === "alpha.txt");
    expect(alpha).toEqual({ name: "alpha.txt", path: "alpha.txt", type: "file", size: 6 });
    expect(body.data.find((entry) => entry.name === "src")).toEqual({ name: "src", path: "src", type: "directory" });
  });

  test("accepts path as an alias for the location directory", async () => {
    const response = await handleFsList(request("/api/fs/list"), requestUrl("/api/fs/list", { path: repo }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as ListBody).location.directory).toBe(repo);
  });

  test("prefers location[directory] over path", async () => {
    const url = requestUrl("/api/fs/list", { "location[directory]": repo, path: join(base, "missing") });
    const response = await handleFsList(request("/api/fs/list"), url);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ListBody).location.directory).toBe(repo);
  });

  test("non-existent directory returns 404 FileNotFoundError", async () => {
    const missing = join(base, "missing");
    const response = await handleFsList(request("/api/fs/list"), requestUrl("/api/fs/list", { "location[directory]": missing }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("FileNotFoundError");
    expect(typeof body.message).toBe("string");
    expect(body.message as string).toContain(missing);
  });

  test("a file path returns 400 InvalidRequestError", async () => {
    const response = await handleFsList(request("/api/fs/list"), requestUrl("/api/fs/list", { "location[directory]": join(repo, "alpha.txt") }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("InvalidRequestError");
  });
});

describe("handleFsFind", () => {
  test("matches names recursively and keeps entry paths relative to the location", async () => {
    const response = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo, query: "gamma" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody;
    expect(body.location.directory).toBe(repo);
    expect(body.data).toEqual([
      { name: "gamma.ts", path: "src/gamma.ts", type: "file", size: Buffer.byteLength("export const gamma = 1;\n") },
    ]);
  });

  test("matches directory names as directories", async () => {
    const response = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo, query: "deep" }));
    const body = (await response.json()) as ListBody;
    expect(body.data).toEqual([{ name: "deep", path: "nested/deep", type: "directory" }]);
  });

  test("matching is case-insensitive", async () => {
    const response = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo, query: "GAMMA" }));
    expect(((await response.json()) as ListBody).data.map((entry) => entry.name)).toEqual(["gamma.ts"]);
  });

  test("skips .git internals", async () => {
    const response = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo, query: "HEAD" }));
    const body = (await response.json()) as ListBody;
    expect(body.data).toEqual([]);
  });

  test("honours limit and clamps it to the maximum", async () => {
    const small = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo, query: "bulk-", limit: "3" }));
    expect(((await small.json()) as ListBody).data.length).toBe(3);

    const capped = await handleFsFind(
      request("/api/fs/find"),
      requestUrl("/api/fs/find", { "location[directory]": repo, query: "bulk-", limit: String(BULK_COUNT) }),
    );
    expect(((await capped.json()) as ListBody).data.length).toBe(MAX_FIND_RESULTS);
  });

  test("rejects a missing query and a non-positive limit", async () => {
    const noQuery = await handleFsFind(request("/api/fs/find"), requestUrl("/api/fs/find", { "location[directory]": repo }));
    expect(noQuery.status).toBe(400);
    expect(((await noQuery.json()) as Record<string, unknown>)._tag).toBe("InvalidRequestError");

    for (const limit of ["0", "abc", "-2", "1.5"]) {
      const response = await handleFsFind(
        request("/api/fs/find"),
        requestUrl("/api/fs/find", { "location[directory]": repo, query: "gamma", limit }),
      );
      expect(response.status).toBe(400);
    }
  });

  test("non-existent directory returns 404 FileNotFoundError", async () => {
    const response = await handleFsFind(
      request("/api/fs/find"),
      requestUrl("/api/fs/find", { "location[directory]": join(base, "missing"), query: "x" }),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("FileNotFoundError");
  });
});

describe("handleLocationGet", () => {
  test("returns the requested location and satisfies location.publicInfo", async () => {
    const response = await handleLocationGet(request("/api/location"), requestUrl("/api/location", { "location[directory]": repo }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: LocationPublicInfo };
    expect(validateResponse("location.publicInfo", body.location)).toEqual({ ok: true });
    expect(body.location.directory).toBe(repo);
  });

  test("defaults to the process working directory", async () => {
    const response = await handleLocationGet(request("/api/location"), requestUrl("/api/location"));
    const body = (await response.json()) as { location: LocationPublicInfo };
    expect(body.location.directory).toBe(process.cwd());
    expect(body.location.project.canonical).toBe(realpathSync(process.cwd()));
  });
});

describe("handleProjectList", () => {
  test("returns the working directory project with epoch-millis time and sandboxes", async () => {
    const response = await handleProjectList(request("/api/project"), requestUrl("/api/project"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PublicProject[];
    expect(body).toHaveLength(1);

    const project = body[0]!;
    expect(project.id).toBe(projectId(process.cwd()));
    expect(project.id).toMatch(/^[0-9a-f]{16}$/);
    expect(project.canonical).toBe(realpathSync(process.cwd()));
    expect(project.sandboxes).toEqual([]);
    expect(Number.isInteger(project.time.created)).toBe(true);
    expect(Number.isInteger(project.time.updated)).toBe(true);
    expect(Number.isInteger(project.time.active)).toBe(true);
    expect(project.time.created).toBeGreaterThan(0);
    expect(project.time.active).toBe(project.time.updated);
    expect(project.time).not.toHaveProperty("archived");
  });
});

describe("handleConfigGet", () => {
  test("returns an empty configuration list", async () => {
    const response = await handleConfigGet(request("/api/config"), requestUrl("/api/config"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual([]);
  });
});

describe("handleVcsGet", () => {
  test("reports the current and default branch inside a repository", async () => {
    const response = await handleVcsGet(request("/api/vcs"), requestUrl("/api/vcs", { "location[directory]": repo }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      location: LocationPublicInfo;
      data: { branch: { current?: string; default?: string } };
    };
    expect(body.location.directory).toBe(repo);
    expect(body.data).toEqual({ branch: { current: "main", default: "main" } });
  });

  test("returns a valid empty branch outside a repository instead of null", async () => {
    for (const directory of [plain, join(base, "missing"), tmpdir()]) {
      const response = await handleVcsGet(request("/api/vcs"), requestUrl("/api/vcs", { "location[directory]": directory }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { branch: Record<string, string> } };
      expect(body.data).toEqual({ branch: {} });
    }
  });
});

describe("handleVcsBase", () => {
  test("returns a null base with the location envelope", async () => {
    const response = await handleVcsBase(request("/api/vcs/base"), requestUrl("/api/vcs/base", { "location[directory]": repo }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: LocationPublicInfo; data: null };
    expect(body.location.project.id).toBe(projectId(repo));
    expect(body.data).toBeNull();
  });
});

describe("handleVcsDiff", () => {
  test("parses numstat into file diffs", async () => {
    appendFileSync(join(repo, "alpha.txt"), "beta\n");
    const response = await handleVcsDiff(request("/api/vcs/diff"), requestUrl("/api/vcs/diff", { "location[directory]": repo }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: LocationPublicInfo; data: FileDiff[] };
    expect(body.data).toEqual([{ file: "alpha.txt", additions: 1, deletions: 0 }]);
  });

  test("returns an empty array outside a repository", async () => {
    const response = await handleVcsDiff(request("/api/vcs/diff"), requestUrl("/api/vcs/diff", { "location[directory]": plain }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: FileDiff[] }).data).toEqual([]);
  });
});

describe("gitRead", () => {
  test("returns stdout on success and null instead of throwing on failure", async () => {
    expect(await gitRead(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main\n");
    expect(await gitRead(plain, ["rev-parse", "--abbrev-ref", "HEAD"])).toBeNull();
    expect(await gitRead(join(base, "missing"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBeNull();
  });
});
