import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const CHECK = join(ROOT, "scripts", "contracts-check.ts");
const OPENCODE = join(ROOT, "contracts", "opencode");
const SENPI = join(ROOT, "contracts", "senpi");

async function runCheck(env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CHECK], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function tempCopy(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-bridge-contracts-"));
  cpSync(source, dir, { recursive: true });
  return dir;
}

describe("contracts:check", () => {
  test("passes on the checked-in contracts", async () => {
    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^contracts: ok \(opencode \d+ endpoints, \d+ samples, senpi \d+ frames\)$/);
  });

  test("fails on a tampered opencode schema and names opencode", async () => {
    const dir = tempCopy(OPENCODE);
    try {
      const file = join(dir, "permission.request.json");
      const schema = JSON.parse(readFileSync(file, "utf8")) as { required: string[] };
      schema.required = schema.required.filter((field) => field !== "resources");
      writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
      const result = await runCheck({ OMO_BRIDGE_CONTRACTS_OPENCODE_DIR: dir });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("opencode:");
      expect(result.stderr).toContain("permission.request");
      expect(result.stdout).not.toContain("contracts: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a tampered sample and names the endpoint", async () => {
    const dir = tempCopy(OPENCODE);
    try {
      const file = join(dir, "samples", "session.messages.json");
      const sample = JSON.parse(readFileSync(file, "utf8")) as { data: Record<string, unknown>[] };
      const assistant = sample.data.find((message) => message.type === "assistant");
      if (assistant === undefined) throw new Error("sample has no assistant message");
      delete assistant.agent;
      assistant.time = { created: "2026-11-05T08:00:00.000Z" };
      writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`);
      const result = await runCheck({ OMO_BRIDGE_CONTRACTS_OPENCODE_DIR: dir });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("opencode: sample session.messages");
      expect(result.stderr).toContain("agent");
      expect(result.stdout).not.toContain("contracts: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a sample carrying an unknown field and names the endpoint", async () => {
    const dir = tempCopy(OPENCODE);
    try {
      const file = join(dir, "samples", "model.list.json");
      const sample = JSON.parse(readFileSync(file, "utf8")) as { data: Record<string, unknown>[] };
      sample.data[0]!.undeclaredField = "unexpected";
      writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`);
      const result = await runCheck({ OMO_BRIDGE_CONTRACTS_OPENCODE_DIR: dir });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("opencode: sample model.list");
      expect(result.stderr).toContain("must NOT have additional properties");
      expect(result.stderr).toContain("undeclaredField");
      expect(result.stdout).not.toContain("contracts: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a tampered senpi fixture and names senpi", async () => {
    const dir = tempCopy(SENPI);
    try {
      const file = join(dir, "events.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const record = JSON.parse(lines[14]!) as { frame: Record<string, unknown>; endpoint: string };
      record.frame.type = "quantum_flux";
      record.endpoint = "quantum_flux";
      lines[14] = JSON.stringify(record);
      writeFileSync(file, `${lines.join("\n")}\n`);
      const result = await runCheck({ OMO_BRIDGE_CONTRACTS_SENPI_DIR: dir });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("senpi:");
      expect(result.stderr).toContain("unknown event type: quantum_flux");
      expect(result.stdout).not.toContain("contracts: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
