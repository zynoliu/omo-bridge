import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";

/**
 * Reads that need no model turn: the command catalogue, the session tree, statistics, the session list and a
 * project file round-trip. Each check names the matrix row it closes.
 */
const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-matrix-reads-"));
  const container = "bridge-qa-matrix-reads-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  try {
    /* The provider catalogue is empty without a key, so the key is passed in when the caller has one — the same
       arrangement api-surface-live uses. */
    const key = process.env.BRIDGE_QA_MODEL_KEY;
    const runArgs = ["run", "-d", "--name", container];
    if (key !== undefined && key.length > 0) runArgs.push("-e", "OPENCODE_API_KEY=" + key);
    docker([...runArgs, IMAGE, "sleep", "infinity"]);
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 70), started.indexOf("lifecycle") !== -1);

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({ socketPath: path.join(scratch, "bridge.sock"), container: container, containerSocket: CONTAINER_SOCKET });
    const transport = await openBridgeTransport({
      socket: gateway.socketPath,
      keyRecord: keyRecord,
      cwd: "/work",
      mini: false,
      handshakeTimeoutMs: 20_000,
    });
    record("transport-authenticated", "authenticated", transport.report.state, transport.report.state === "authenticated");

    const opened = await transport.request("open_session", { cwd: "/work" });
    const sessionId = JSON.stringify(opened).match(/"sessionId":"([^"]+)"/)?.[1];

    const commands = (await transport.request("get_commands", { sessionId: sessionId })) as { success?: boolean; data?: unknown };
    const commandText = JSON.stringify(commands.data ?? null);
    record("P-702-command-list", "the host returns a command catalogue", commandText.slice(0, 120), commands.success === true && commandText.length > 10);

    const list = (await transport.request("list_sessions", {})) as { success?: boolean; data?: unknown };
    const listText = JSON.stringify(list.data ?? null);
    record("P-614-session-view", "the host lists the session it holds", listText.slice(0, 120), list.success === true && listText.indexOf("-") !== -1);

    const stats = (await transport.request("get_session_stats", { sessionId: sessionId })) as { success?: boolean; data?: unknown };
    const statsText = JSON.stringify(stats.data ?? null);
    record("P-738-session-stats", "the host reports statistics instead of refusing", statsText.slice(0, 120), stats.success === true);

    const tree = (await transport.request("get_tree", { sessionId: sessionId })) as { success?: boolean; data?: unknown };
    const treeText = JSON.stringify(tree.data ?? null);
    record("P-726-session-tree", "the host returns a tree structure", treeText.slice(0, 120), tree.success === true && treeText.length > 2);

    /* The host restricts this method to instruction files on purpose, and the write is an optimistic one:
       it wants the etag the read returned (`ifEtag`), or null when the file does not exist yet. */
    const before = (await transport.request("read_project_file", { sessionId: sessionId, path: "AGENTS.md" })) as {
      success?: boolean;
      data?: { etag?: unknown };
    };
    const etag = before.success === true ? (before.data?.etag ?? null) : null;
    const written = (await transport.request("write_project_file", {
      sessionId: sessionId,
      path: "AGENTS.md",
      content: "written by qa\n",
      ifEtag: etag,
    })) as { success?: boolean; error?: string };
    const read = (await transport.request("read_project_file", { sessionId: sessionId, path: "AGENTS.md" })) as { success?: boolean; data?: unknown };
    const readText = JSON.stringify(read.data ?? null);
    record(
      "P-756-file-read",
      "a file written through the host reads back with its content",
      written.success === true ? readText.slice(0, 120) : "write refused: " + String(written.error).slice(0, 80),
      written.success === true && readText.indexOf("written by qa") !== -1,
    );

    const models = (await transport.request("get_available_models", { sessionId: sessionId })) as { success?: boolean; data?: unknown };
    const modelsText = JSON.stringify(models.data ?? null);
    const providers = Array.from(modelsText.matchAll(/"provider(?:ID)?":"([^"]+)"/g)).map((hit) => hit[1]);
    record(
      "P-692-provider-list",
      "the catalogue names the providers it serves",
      Array.from(new Set(providers)).join(",").slice(0, 100),
      models.success === true && providers.length > 0,
    );

    const limits = (await transport.request("get_subscription_limits", {})) as { success?: boolean; data?: unknown };
    record("P-696-usage-limits", "the host answers the usage-limits read", JSON.stringify(limits.data ?? null).slice(0, 120), limits.success === true);

    const settings = (await transport.request("get_project_settings", { sessionId: sessionId })) as { success?: boolean; data?: unknown };
    record("P-769-config-get", "the host returns its project settings", JSON.stringify(settings.data ?? null).slice(0, 120), settings.success === true);

    transport.close();
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    if (gateway !== undefined) {
      detail.push("gateway closed with " + String(gateway.open()) + " forwarded connection(s)");
      await gateway.close();
    }
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    detail.push("staged key record and scratch socket removed");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
