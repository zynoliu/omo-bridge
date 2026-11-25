import * as fs from "node:fs";
import * as path from "node:path";

export const BASE_IMAGE = "oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d";
export const CONTAINER_UID = 10001;
export const CONTAINER_HOME = "/home/bridge";
const DOCKER_SOCKET = "/var/run/docker.sock";

export class MountPolicyError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(reason + ": " + detail);
    this.name = "MountPolicyError";
    this.reason = reason;
  }
}

export type Mount = {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
};

export type MountPolicy = {
  readonly userHome: string;
  readonly runRoot: string;
  readonly forbiddenRoots: readonly string[];
};

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertSafeMount(mount: Mount, policy: MountPolicy): void {
  if (!path.isAbsolute(mount.source)) throw new MountPolicyError("RELATIVE_MOUNT_SOURCE", mount.source);
  if (!path.isAbsolute(mount.target)) throw new MountPolicyError("RELATIVE_MOUNT_TARGET", mount.target);
  if (mount.target === "/") throw new MountPolicyError("ROOT_MOUNT_TARGET", mount.target);

  const source = path.resolve(mount.source);
  if (source === DOCKER_SOCKET || path.basename(source) === "docker.sock") {
    throw new MountPolicyError("DOCKER_SOCKET_MOUNT", source);
  }
  if (!isInside(source, path.resolve(policy.runRoot))) {
    throw new MountPolicyError("MOUNT_OUTSIDE_RUN_ROOT", source);
  }
  for (const forbidden of policy.forbiddenRoots) {
    const resolved = path.resolve(forbidden);
    if (isInside(resolved, source) || isInside(source, resolved)) {
      throw new MountPolicyError("FORBIDDEN_PATH_MOUNT", source);
    }
  }
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new MountPolicyError("SYMLINK_MOUNT_SOURCE", source);
  if (!stat.isDirectory()) throw new MountPolicyError("MOUNT_SOURCE_NOT_DIRECTORY", source);
}

export function assertSafeMounts(mounts: readonly Mount[], policy: MountPolicy): void {
  const targets = new Set<string>();
  for (const mount of mounts) {
    assertSafeMount(mount, policy);
    if (targets.has(mount.target)) throw new MountPolicyError("DUPLICATE_MOUNT_TARGET", mount.target);
    targets.add(mount.target);
  }
}

export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const DOCKER_BINARY = Bun.which("docker") ?? "/usr/local/bin/docker";

export async function docker(args: readonly string[], timeoutMs = 120_000): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [DOCKER_BINARY, ...args],
    env: { ...process.env, DOCKER_CLI_HINTS: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code: code, stdout: stdout, stderr: stderr };
}
