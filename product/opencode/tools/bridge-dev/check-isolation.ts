import * as fs from "node:fs";
import * as path from "node:path";

import {
  BASE_IMAGE,
  CONTAINER_HOME,
  CONTAINER_UID,
  MountPolicyError,
  assertSafeMounts,
  docker,
} from "./container.ts";
import type { Mount } from "./container.ts";

type Check = { readonly name: string; readonly expected: string; readonly observed: string; readonly pass: boolean };

class UsageError extends Error {}

type Options = { readonly caseName: string; readonly out: string };

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--case" && flag !== "--out") throw new UsageError("unknown option " + String(flag));
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError("missing value for " + flag);
    values.set(flag, value);
    index += 1;
  }
  const caseName = values.get("--case");
  const out = values.get("--out");
  if (caseName === undefined || out === undefined) throw new UsageError("--case and --out are required");
  return { caseName: caseName, out: out };
}

function randomSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function createOutputDirectory(out: string): string {
  const resolved = path.resolve(out);
  fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
  return resolved;
}

function writeJson(file: string, value: unknown): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

async function execIn(container: string, argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  const result = await docker(["exec", container, ...argv], 60_000);
  return { code: result.code, stdout: result.stdout.trim() };
}

async function containerCase(out: string): Promise<{ code: number; checks: Check[] }> {
  const suffix = randomSuffix();
  const tag = "bridge-dev:qa-" + suffix;
  const name = "bridge-dev-qa-" + suffix;
  const contextDirectory = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const runRoot = path.join(out, "run");

  for (const directory of ["home", "agent", "data", "sockets"]) {
    fs.mkdirSync(path.join(runRoot, directory), { recursive: true, mode: 0o700 });
  }

  const mounts: Mount[] = [
    { source: path.join(runRoot, "home"), target: "/home/bridge", readOnly: false },
    { source: path.join(runRoot, "agent"), target: "/opt/agent", readOnly: false },
    { source: path.join(runRoot, "data"), target: "/data", readOnly: false },
    { source: path.join(runRoot, "sockets"), target: "/sockets", readOnly: false },
  ];

  const userHome = process.env.HOME ?? "";
  assertSafeMounts(mounts, {
    userHome: userHome,
    runRoot: runRoot,
    forbiddenRoots: [userHome, path.join(userHome, ".omo"), path.join(userHome, "Library", "Application Support", "omo")],
  });

  const checks: Check[] = [];
  let cleanupOk = false;
  let exitCode = 1;

  try {
    const build = await docker(["build", "--tag", tag, "--file", path.join(contextDirectory, "Dockerfile"), contextDirectory], 600_000);
    checks.push({
      name: "image-build",
      expected: "exit 0",
      observed: "exit " + String(build.code),
      pass: build.code === 0,
    });
    if (build.code !== 0) return { code: 2, checks };

    const inspectImage = await docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
    checks.push({
      name: "image-identity",
      expected: "non-empty immutable image id",
      observed: inspectImage.stdout.trim(),
      pass: inspectImage.code === 0 && inspectImage.stdout.trim().startsWith("sha256:"),
    });

    const args = ["run", "--detach", "--name", name, "--network", "none", "--user", String(CONTAINER_UID) + ":" + String(CONTAINER_UID)];
    for (const mount of mounts) args.push("--volume", mount.source + ":" + mount.target + (mount.readOnly ? ":ro" : ":rw"));
    args.push(tag);
    const run = await docker(args);
    checks.push({
      name: "container-start",
      expected: "exit 0",
      observed: "exit " + String(run.code) + " " + run.stderr.trim().slice(0, 200),
      pass: run.code === 0,
    });
    if (run.code !== 0) return { code: 3, checks };

    const uid = await execIn(name, ["id", "-u"]);
    checks.push({ name: "unprivileged-user", expected: String(CONTAINER_UID), observed: uid.stdout, pass: uid.stdout === String(CONTAINER_UID) });

    const home = await execIn(name, ["sh", "-c", "printf %s \"$HOME\""]);
    checks.push({ name: "container-home", expected: CONTAINER_HOME, observed: home.stdout, pass: home.stdout === CONTAINER_HOME });

    const hostUsers = await execIn(name, ["sh", "-c", "ls -d /Users 2>/dev/null || echo ABSENT"]);
    checks.push({ name: "host-home-not-mounted", expected: "ABSENT", observed: hostUsers.stdout, pass: hostUsers.stdout === "ABSENT" });

    const dockerSocket = await execIn(name, ["sh", "-c", "test ! -e /var/run/docker.sock && echo ABSENT || echo PRESENT"]);
    checks.push({ name: "docker-socket-not-mounted", expected: "ABSENT", observed: dockerSocket.stdout, pass: dockerSocket.stdout === "ABSENT" });

    const mountPoints = await execIn(name, ["sh", "-c", "for p in /opt/agent /data /sockets; do test -d \"$p\" && echo -n \"$p;\"; done"]);
    checks.push({
      name: "run-directories-mounted",
      expected: "/opt/agent;/data;/sockets;",
      observed: mountPoints.stdout,
      pass: mountPoints.stdout === "/opt/agent;/data;/sockets;",
    });

    const network = await execIn(name, [
      "bun",
      "-e",
      "try{const r=await fetch(\"https://example.com\",{signal:AbortSignal.timeout(4000)});console.log(\"CONNECTED\",r.status)}catch{console.log(\"BLOCKED\")}",
    ]);
    checks.push({ name: "network-disabled", expected: "BLOCKED", observed: network.stdout, pass: network.stdout === "BLOCKED" });

    const inspectMounts = await docker(["inspect", name, "--format", "{{range .Mounts}}{{.Source}};{{end}}"]);
    const observedSources = inspectMounts.stdout.trim().split(";").filter((value) => value.length > 0).sort();
    const expectedSources = mounts.map((mount) => mount.source).sort();
    checks.push({
      name: "mount-set-exact",
      expected: expectedSources.join(","),
      observed: observedSources.join(","),
      pass: JSON.stringify(observedSources) === JSON.stringify(expectedSources),
    });

    exitCode = checks.every((check) => check.pass) ? 0 : 4;
  } finally {
    const removal = await docker(["rm", "--force", name], 120_000);
    const imageRemoval = await docker(["image", "rm", "--force", tag], 120_000);
    const remaining = await docker(["ps", "--all", "--quiet", "--filter", "name=^" + name + "$"]);
    const imageLeft = await docker(["image", "inspect", tag]);
    cleanupOk =
      remaining.stdout.trim() === "" &&
      imageLeft.code !== 0 &&
      (removal.code === 0 || removal.stderr.includes("No such container")) &&
      (imageRemoval.code === 0 || imageRemoval.stderr.includes("No such image"));
    fs.rmSync(runRoot, { recursive: true, force: true });
    writeJson(path.join(out, "cleanup.json"), {
      containerRemoved: remaining.stdout.trim() === "",
      imageRemoved: imageLeft.code !== 0,
      runDirectoryRemoved: !fs.existsSync(runRoot),
      cleanupOk: cleanupOk,
    });
  }

  if (!cleanupOk) {
    checks.push({ name: "cleanup", expected: "container, image and run directory removed", observed: "incomplete", pass: false });
    return { code: 5, checks };
  }
  return { code: exitCode, checks: checks };
}

async function rejectHostMountCase(out: string): Promise<{ code: number; checks: Check[] }> {
  const runRoot = path.join(out, "run");
  fs.mkdirSync(path.join(runRoot, "home"), { recursive: true, mode: 0o700 });
  const userHome = process.env.HOME ?? "";
  const checks: Check[] = [];
  let rejected = false;
  let reason = "none";
  try {
    assertSafeMounts(
      [{ source: userHome, target: "/home/real", readOnly: true }],
      { userHome: userHome, runRoot: runRoot, forbiddenRoots: [userHome] },
    );
  } catch (error) {
    if (error instanceof MountPolicyError) {
      rejected = true;
      reason = error.reason;
    } else {
      throw error;
    }
  }
  checks.push({ name: "host-mount-rejected", expected: "MountPolicyError", observed: reason, pass: rejected });

  const containers = await docker(["ps", "--all", "--quiet", "--filter", "name=^bridge-dev-qa-"]);
  checks.push({
    name: "no-container-created",
    expected: "no bridge-dev-qa container exists",
    observed: containers.stdout.trim() === "" ? "none" : "present",
    pass: containers.stdout.trim() === "",
  });

  fs.rmSync(runRoot, { recursive: true, force: true });
  writeJson(path.join(out, "cleanup.json"), {
    containerCreated: false,
    runDirectoryRemoved: !fs.existsSync(runRoot),
    cleanupOk: true,
  });
  return { code: checks.every((check) => check.pass) ? 0 : 6, checks: checks };
}

const options = (() => {
  try {
    return parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("usage: check-isolation.ts --case <container|reject-host-mount> --out <directory>\n");
    process.stderr.write("error: " + (error as Error).message + "\n");
    process.exit(64);
  }
})();

const out = createOutputDirectory(options.out);
const result =
  options.caseName === "container"
    ? await containerCase(out)
    : options.caseName === "reject-host-mount"
      ? await rejectHostMountCase(out)
      : (() => {
          process.stderr.write("error: unknown case " + options.caseName + "\n");
          process.exit(65);
          throw new Error("unreachable");
        })();

writeJson(path.join(out, "result.json"), {
  case: options.caseName,
  baseImage: BASE_IMAGE,
  checks: result.checks,
  verdict: result.checks.every((check) => check.pass) ? "PASS" : "FAIL",
});
process.exit(result.code);
