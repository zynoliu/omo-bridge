export {};

const writes: string[] = [];
const original = process.stdout.write.bind(process.stdout);

process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  return original(chunk as string, ...(rest as [BufferEncoding?, (() => void)?]));
}) as typeof process.stdout.write;

const transportModule = await import("../../src/senpi/transport");
await new Promise((resolve) => setTimeout(resolve, 300));
process.stdout.write = original;

const offending = writes.filter((entry) => entry.includes("extension_ui_request"));
process.stdout.write(
  `${JSON.stringify({ offending, hasTransport: typeof transportModule.SenpiTransport === "function" })}\n`,
);
