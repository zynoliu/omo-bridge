import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

import { openSocketGateway } from "./socket-gateway.ts";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-gateway-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** An echo server standing in for the host socket: it answers exactly what it was sent. */
async function echoServer(): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const dir = tempRoot();
  const socketPath = path.join(dir, "host.sock");
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => connection.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Runs the same relay the container runs, but locally, so the gateway seam is under test. */
function localRelay(containerSocket: string) {
  return spawn(process.execPath, [path.join(import.meta.dir, "host", "relay.mjs"), containerSocket], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Reads until the expected bytes arrive, bounded by a deadline rather than a fixed sleep. */
async function readUntil(connection: net.Socket, needle: string, deadlineMs = 10_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let seen = "";
  while (Date.now() < deadline && !seen.includes(needle)) {
    const chunk = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), 50);
      connection.once("data", (data) => {
        clearTimeout(timer);
        resolve(data.toString("utf8"));
      });
    });
    seen += chunk;
  }
  return seen;
}

describe("bridge socket gateway", () => {
  test("the socket exists with owner-only permissions and carries bytes both ways", async () => {
    const host = await echoServer();
    const root = tempRoot();
    const gateway = await openSocketGateway({
      socketPath: path.join(root, "bridge.sock"),
      container: "unused-in-this-test",
      containerSocket: host.socketPath,
      spawnRelay: localRelay,
    });
    try {
      const mode = statSync(gateway.socketPath).mode & 0o777;
      expect(mode).toBe(0o600);

      const connection = net.connect(gateway.socketPath);
      await new Promise<void>((resolve, reject) => {
        connection.once("connect", () => resolve());
        connection.once("error", reject);
      });
      connection.write("hello-through-the-gateway");
      const seen = await readUntil(connection, "hello-through-the-gateway");
      expect(seen).toContain("hello-through-the-gateway");
      connection.destroy();
    } finally {
      await gateway.close();
      await host.close();
    }
    expect(gateway.open()).toBe(0);
  }, 30_000);

  test("two connections are forwarded independently", async () => {
    const host = await echoServer();
    const root = tempRoot();
    const gateway = await openSocketGateway({
      socketPath: path.join(root, "bridge.sock"),
      container: "unused-in-this-test",
      containerSocket: host.socketPath,
      spawnRelay: localRelay,
    });
    try {
      const first = net.connect(gateway.socketPath);
      const second = net.connect(gateway.socketPath);
      await Promise.all([
        new Promise<void>((resolve) => first.once("connect", () => resolve())),
        new Promise<void>((resolve) => second.once("connect", () => resolve())),
      ]);
      first.write("one");
      second.write("two");
      expect(await readUntil(first, "one")).toContain("one");
      expect(await readUntil(second, "two")).toContain("two");
      first.destroy();
      second.destroy();
    } finally {
      await gateway.close();
      await host.close();
    }
  }, 30_000);

  test("closing the gateway removes the socket and leaves no relay running", async () => {
    const host = await echoServer();
    const root = tempRoot();
    const socketPath = path.join(root, "bridge.sock");
    const gateway = await openSocketGateway({
      socketPath: socketPath,
      container: "unused-in-this-test",
      containerSocket: host.socketPath,
      spawnRelay: localRelay,
    });
    const connection = net.connect(socketPath);
    await new Promise<void>((resolve) => connection.once("connect", () => resolve()));
    await gateway.close();
    await host.close();
    expect(() => statSync(socketPath)).toThrow();
    expect(gateway.open()).toBe(0);
    connection.destroy();
  }, 30_000);
});
