#!/usr/bin/env bun
/**
 * Builds the bridge launcher as runnable artifacts.
 *
 * The TUI is written against solid JSX, so every build runs the same solid transform the TUI uses.
 * Two shapes come out: the bundle, and a compiled per-architecture directory that also carries the
 * native packages the launcher resolves at runtime — a binary without them fails at its first import.
 * Each artifact is then launched with no arguments and must refuse a missing --socket.
 */
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import pkg from "../package.json";
import { auditArtifacts } from "./distribution.ts";

const dir = path.resolve(import.meta.dirname, "..");
const outdir = path.resolve(dir, "dist-bridge");
if (outdir === dir) throw new Error("refusing to build over the package directory");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/** Every per-platform addon @opentui/core may import, read from its own manifest rather than guessed. */
function opentuiManifest(): { version: string; addons: string[] } {
  const manifest = require.resolve("@opentui/core/package.json", { paths: [import.meta.dirname] });
  const core = JSON.parse(readFileSync(manifest, "utf8")) as {
    version: string;
    optionalDependencies?: Record<string, string>;
  };
  return {
    version: core.version,
    addons: Object.keys(core.optionalDependencies ?? {}).filter((name) => name.startsWith("@opentui/core-")),
  };
}

const opentui = opentuiManifest();
/* The versions the workspace resolves, so a distribution ships what the TUI was tested against. */
const nativeDependencies = {
  "@opencode/pty": pkg.dependencies["@opencode/pty"],
  "@opentui/core": opentui.version,
};

const bundle = await Bun.build({
  entrypoints: [path.join(dir, "src", "bridge-run.ts")],
  outdir: outdir,
  target: "bun",
  format: "esm",
  splitting: false,
  sourcemap: "none",
  plugins: [createSolidTransformPlugin()],
  /* Platform addons are selected at runtime, so they stay external. */
  external: opentui.addons,
});

if (!bundle.success) {
  for (const log of bundle.logs) console.error(String(log));
  console.error(JSON.stringify({ ok: false, stage: "bundle" }));
  process.exit(1);
}

const artifact = path.join(outdir, "bridge-run.js");

/** One architecture's directory: the compiled binary plus its native packages installed for that platform only. */
async function buildDistribution(arch: "arm64" | "x64") {
  const target: "bun-darwin-arm64" | "bun-darwin-x64" = arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
  const dist = path.join(outdir, `bridge-darwin-${arch}`);
  await mkdir(dist, { recursive: true });
  const binary = path.join(dist, "bridge-run");
  const compiled = await Bun.build({
    entrypoints: [path.join(dir, "src", "bridge-run.ts")],
    target: "bun",
    plugins: [createSolidTransformPlugin()],
    external: opentui.addons,
    compile: { target, outfile: binary },
  });
  if (!compiled.success) {
    for (const log of compiled.logs) console.error(String(log));
    console.error(JSON.stringify({ ok: false, stage: "compile", arch }));
    process.exit(1);
  }
  await Bun.write(
    path.join(dist, "package.json"),
    JSON.stringify({ name: `bridge-launcher-darwin-${arch}`, private: true, dependencies: nativeDependencies }, null, 2) + "\n",
  );
  const installed = Bun.spawnSync({
    cmd: [process.execPath, "install", `--os=darwin`, `--cpu=${arch}`, "--no-progress"],
    cwd: dist,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (installed.exitCode !== 0) {
    console.error(JSON.stringify({ ok: false, stage: "native-packages", arch, exitCode: installed.exitCode }));
    process.exit(1);
  }
  /* An x64 binary runs here only under Rosetta; when the emulator is absent the audit reports that
     architecture as unlaunchable instead of assuming it works. */
  return { arch, dir: dist, binary };
}

const distributions = [await buildDistribution("arm64"), await buildDistribution("x64")];

/* The bundle has no platform packages beside it, so its refusal comes from source semantics. */
const smoke = Bun.spawnSync({
  cmd: [process.execPath, path.join(dir, "src", "bridge-run.ts")],
  env: { ...process.env },
  stdout: "pipe",
  stderr: "pipe",
});
const stderr = new TextDecoder().decode(smoke.stderr ?? new Uint8Array());
if (smoke.exitCode !== 2 || !stderr.includes("--socket")) {
  console.error(JSON.stringify({ ok: false, stage: "smoke", exitCode: smoke.exitCode, stderr: stderr.slice(0, 200) }));
  process.exit(1);
}

const unlaunched = auditArtifacts(outdir, distributions.map((entry) => entry.arch));
if (!unlaunched.ok) {
  console.error(JSON.stringify({ ok: false, stage: "audit", missing: unlaunched.missing, unlaunchable: unlaunched.unlaunchable }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    artifact,
    version: pkg.version,
    distributions: distributions.map((entry) => ({ arch: entry.arch, binary: entry.binary })),
  }),
);
