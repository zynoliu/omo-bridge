import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SenpiTransport } from "../../src/senpi/transport";
import { FakeSenpiHost } from "./fake-host";

/**
 * The fake host must answer the way the recorded host did. These assertions read the recording
 * themselves instead of trusting the fake's copy of it, so an invented handshake or a missing
 * `isStreaming` fails here rather than only against the real host.
 */
const repoRoot = join(import.meta.dir, "..", "..");

interface RecordedLine {
  readonly frame: Record<string, unknown>;
  readonly role?: string;
}

function readRecording(file: string): RecordedLine[] {
  return readFileSync(join(repoRoot, "contracts", "senpi", file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedLine);
}

function recordedAnswer(command: string): Record<string, unknown> {
  const line = readRecording("live.jsonl").find(
    (entry) => entry.role === "response" && entry.frame.command === command && entry.frame.success === true,
  );
  if (line === undefined) throw new Error(`contracts/senpi/live.jsonl holds no ${command} answer`);
  return line.frame.data as Record<string, unknown>;
}

describe("fake host fidelity", () => {
  test("the handshake answers the recorded capability set, not an invented one", async () => {
    const recorded = recordedAnswer("get_protocol_info") as { capabilities: string[]; serverVersion?: string };
    const recordedCapabilities = [...recorded.capabilities].sort();
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      expect(host.connections.length).toBeGreaterThan(0);
      for (const connection of host.connections) {
        const answer = connection.sent.find(
          (frame) => frame.type === "response" && frame.command === "get_protocol_info",
        );
        expect(answer?.success).toBe(true);
        const data = answer?.data as { capabilities?: string[]; serverVersion?: string } | undefined;
        expect([...(data?.capabilities ?? [])].sort()).toEqual(recordedCapabilities);
        expect(data?.capabilities).toHaveLength(recordedCapabilities.length);
        expect(data?.serverVersion).toBe(recorded.serverVersion);
      }
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("open_session answers with the recorded state, isStreaming included", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const opened = await transport.openSession({ cwd: host.dir });
      const state = ("state" in opened ? opened.state : undefined) as { isStreaming?: boolean } | undefined;
      expect(state?.isStreaming).toBe(false);
      expect(transport.streaming).toBe(false);

      const wire = (host.connections[0]?.sent.find(
        (frame) => frame.type === "response" && frame.command === "open_session",
      )?.data ?? {}) as { state?: { isStreaming?: unknown } };
      expect(wire.state).toHaveProperty("isStreaming", false);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("the transport seeds streaming from the open_session answer", async () => {
    const host = FakeSenpiHost.start({ streaming: true });
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const opened = await transport.openSession({ cwd: host.dir });
      const state = ("state" in opened ? opened.state : undefined) as { isStreaming?: boolean } | undefined;
      expect(state?.isStreaming).toBe(true);
      expect(transport.streaming).toBe(true);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("finishTurn replays the recorded terminal frames in recorded order", async () => {
    const recordedEnd = readRecording("events.jsonl").find((entry) => entry.frame.type === "agent_end")?.frame;
    if (recordedEnd === undefined) throw new Error("contracts/senpi/events.jsonl holds no agent_end frame");
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    const seen: string[] = [];
    try {
      await transport.connect();
      await transport.openSession({ cwd: host.dir });
      transport.onEvent((event) => seen.push(String((event as { type?: unknown }).type)));
      host.finishTurn();
      await transport.waitForIdle(2_000);
      expect(seen.filter((type) => ["agent_end", "agent_settled", "agent_idle"].includes(type))).toEqual([
        "agent_end",
        "agent_settled",
        "agent_idle",
      ]);
      const answer = host.connections[0]?.sent.find((frame) => frame.type === "agent_end");
      expect(answer?.messages).toEqual(recordedEnd.messages);
      expect(answer?.willRetry).toBe(recordedEnd.willRetry);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });
});
