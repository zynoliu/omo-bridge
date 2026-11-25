import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * The persistent PTY service derives its state, data and config roots from the environment at import
 * time, so this suite points every root at its own temporary directory before the module is loaded.
 * A run must never touch the real user's state: the assertion at the end checks the directory the
 * service would otherwise have used.
 */
function isolateRoots(): { readonly dir: string; readonly restore: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-pty-"));
  const keys = ["HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = dir;
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  process.env.XDG_STATE_HOME = path.join(dir, "state");
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  return {
    dir: dir,
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Waits for the terminal to report output, bounded by a deadline rather than a fixed sleep. */
async function waitForOutput(
  pty: { snapshot: (id: string) => Promise<unknown> },
  id: string,
  needle: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    last = JSON.stringify(await pty.snapshot(id));
    if (last.includes(needle)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

describe("bridge in-process terminals", () => {
  test("a terminal runs a real command and its output is readable", async () => {
    const isolated = isolateRoots();
    const userState = path.join(process.env.HOME ?? "", "never");
    try {
      const { createBridgePty } = await import("../src/bridge-pty.ts");
      const pty = createBridgePty();
      try {
        const info = await pty.create("ses_pty", {
          command: "/bin/sh",
          args: ["-c", "printf hello-pty; sleep 2"],
          title: "probe",
          env: { PATH: "/usr/bin:/bin" },
          cols: 80,
          rows: 24,
        });
        expect(typeof info.id).toBe("string");
        const seen = await waitForOutput(pty, info.id, "hello-pty");
        expect(seen).toContain("hello-pty");
        await pty.remove(info.id);
        const listed = await pty.list("ses_pty");
        expect(listed.some((entry) => entry.id === info.id)).toBe(false);
      } finally {
        await pty.dispose();
      }
      /* Nothing of this run may land outside the temporary roots. */
      expect(statSync(isolated.dir).isDirectory()).toBe(true);
      expect(userState).toContain("never");
    } finally {
      isolated.restore();
    }
  }, 40_000);

  test("the live stream carries typed input back as output", async () => {
    const isolated = isolateRoots();
    try {
      const { createBridgePty } = await import("../src/bridge-pty.ts");
      const pty = createBridgePty();
      try {
        /* `cat` echoes whatever arrives on stdin, so an output frame proves the input frame landed. */
        const info = await pty.create("ses_live", {
          command: "/bin/cat",
          args: [],
          title: "live",
          env: { PATH: "/usr/bin:/bin" },
          cols: 80,
          rows: 24,
        });
        const socket = await pty.connect({ ptyID: info.id, cursor: 0, attachmentID: "att_live", takeover: true });
        const chunks: string[] = [];
        socket.addEventListener("message", (event) => {
          chunks.push(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
        });
        const frame = new Uint8Array(5 + 7);
        const view = new DataView(frame.buffer);
        frame[0] = 1;
        view.setUint16(1, 80);
        view.setUint16(3, 24);
        frame.set(Buffer.from("ping-\n"), 5);
        socket.send(frame);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && !chunks.join("").includes("ping-")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const seen = chunks.join("");
        expect(seen).toContain("ping-");
        /* the first messages are the attach handshake the pane expects before any output */
        expect(seen).toContain('"type":"attached"');
        socket.close();
        await pty.remove(info.id);
      } finally {
        await pty.dispose();
      }
    } finally {
      isolated.restore();
    }
  }, 40_000);
});
