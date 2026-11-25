import * as fs from "node:fs";
import { JsonlFrameDecoder } from "../../../packages/bridge-core/src/transport.ts";

export async function pump(socketPath: string, events: readonly unknown[]): Promise<readonly string[]> {
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
  const client = await Bun.connect({ unix: socketPath, socket: { data() {}, open() {}, close() {}, error() {} } });
  for (const event of events) client.write(Buffer.from(JSON.stringify(event) + "\n", "utf8"));
  await Bun.sleep(50);
  client.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    server.stop(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  return frames;
}
