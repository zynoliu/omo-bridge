import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBridgePty } from "../src/bridge-pty.ts";

const pty = createBridgePty();
const roots: string[] = [];

afterAll(async () => {
  await pty.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The pane writes a 5-byte header (flag, cols, rows) before the bytes the user typed. */
function inputFrame(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + bytes.byteLength);
  frame[0] = 1;
  new DataView(frame.buffer).setUint16(1, 80);
  new DataView(frame.buffer).setUint16(3, 24);
  frame.set(bytes, 5);
  return frame;
}

async function waitForText(read: () => string, needle: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("bridge pty socket", () => {
  test("the socket reports open, and typed input reaches the shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-pty-"));
    roots.push(root);
    const info = await pty.create("ses_qa", { args: [], cwd: root, title: "probe", env: {}, cols: 80, rows: 24 });
    const socket = await pty.connect({ ptyID: info.id, cursor: 0, attachmentID: "attach-1", takeover: true });
    let output = "";
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) output += new TextDecoder().decode(new Uint8Array(event.data));
      else output += String(event.data);
    });
    expect(socket.readyState).toBe(1);
    socket.send(inputFrame("echo BRIDGE_PTY_INPUT_REACHED_SHELL\r"));
    expect(await waitForText(() => output, "BRIDGE_PTY_INPUT_REACHED_SHELL")).toBe(true);
    socket.close();
    expect(socket.readyState).toBe(3);
    await pty.remove(info.id).catch(() => undefined);
  }, 30_000);
});
