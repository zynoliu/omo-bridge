import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { JsonlFrameDecoder } from "../../../packages/bridge-core/src/transport.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "transport.sock");
  const decoder = new JsonlFrameDecoder();
  const frames: string[] = [];

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        frames.push(...decoder.push(chunk));
      },
      open() {},
      close() {},
      error() {},
    },
  });

  const payload = JSON.stringify({ kind: "message.delta", text: "中文CRLF" }) + "\r\n";
  const bytes = Buffer.from(payload, "utf8");
  const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 2;

  const client = await Bun.connect({
    unix: socketPath,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  client.write(bytes.subarray(0, cut));
  client.write(bytes.subarray(cut, cut + 3));
  client.write(bytes.subarray(cut + 3));
  await Bun.sleep(50);
  client.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    server.stop(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  const parsed = frames.map((frame) => JSON.parse(frame) as { text?: string });
  const checks: Check[] = [
    {
      name: "single-frame-over-socket",
      expected: "exactly one decoded frame",
      observed: String(frames.length) + " frame(s)",
      pass: frames.length === 1,
    },
    {
      name: "split-utf8-and-crlf-reassembled",
      expected: "text 中文CRLF",
      observed: JSON.stringify(parsed[0]?.text ?? null),
      pass: parsed.length === 1 && parsed[0]?.text === "中文CRLF",
    },
  ];

  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  const socketGone = !fs.existsSync(socketPath);
  return { checks: checks, cleanup: { ok: socketGone, detail: [socketGone ? "socket removed" : "socket left behind"] } };
}
