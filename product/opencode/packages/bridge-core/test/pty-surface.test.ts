import { describe, expect, test } from "bun:test";

import { PtyUnavailable, createPtySurface } from "../src/pty-surface.ts";

describe("createPtySurface", () => {
  test("issues a token bound to the configured socket with an expiry", async () => {
    const surface = createPtySurface({ socketPath: "/tmp/bridge.sock", now: () => 1000, tokenTtlMs: 5000 });
    const token = await surface.experimental.persistentPty.connectToken();
    expect(token.socket).toBe("/tmp/bridge.sock");
    expect(token.expiresAt).toBe(6000);
    expect(/^[0-9a-f]{32}$/.test(token.token)).toBe(true);
  });

  test("tokens differ between calls so one cannot be replayed by guessing", async () => {
    const surface = createPtySurface({ socketPath: "/tmp/bridge.sock" });
    const a = await surface.experimental.persistentPty.connectToken();
    const b = await surface.experimental.persistentPty.connectToken();
    expect(a.token).not.toBe(b.token);
  });

  test("no socket configured raises a typed error instead of inventing one", async () => {
    const surface = createPtySurface({ socketPath: null });
    await expect(surface.experimental.persistentPty.connectToken()).rejects.toBeInstanceOf(PtyUnavailable);
  });

  test("pty.create returns distinct ids and rejects an oversized title", async () => {
    const surface = createPtySurface({ socketPath: "/tmp/bridge.sock" });
    const first = await surface.pty.create({ title: "one" });
    const second = await surface.pty.create({ title: "two" });
    expect(first.id).not.toBe(second.id);
    await expect(surface.pty.create({ title: "x".repeat(201) })).rejects.toBeInstanceOf(PtyUnavailable);
  });
});
