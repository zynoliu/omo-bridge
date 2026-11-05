import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RpcTransportGoneError } from "@code-yeongyu/senpi";
import { SenpiTransportError, mapSenpiError } from "../../src/senpi/errors";
import { loadAttachClient } from "../../src/senpi/raw";
import { SenpiTransport } from "../../src/senpi/transport";
import { FakeSenpiHost } from "./fake-host";

const repoRoot = join(import.meta.dir, "..", "..");

describe("error mapping", () => {
  test("a missing private socket maps to socket_missing", async () => {
    const transport = new SenpiTransport({ socketPath: join(repoRoot, ".nonexistent-senpi.sock"), keyRoot: repoRoot });
    const error = await transport.connect().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SenpiTransportError);
    expect((error as SenpiTransportError).code).toBe("socket_missing");
    await transport.dispose();
  });

  test("a host authentication refusal maps to auth_failed", async () => {
    const host = FakeSenpiHost.start({ rejectAuth: true });
    try {
      const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
      const error = await transport.connect().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("auth_failed");
      await transport.dispose();
    } finally {
      host.stop();
    }
  });

  test("a lost transport maps to transport_gone", async () => {
    expect(mapSenpiError(new RpcTransportGoneError()).code).toBe("transport_gone");

    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const gone = new Promise<SenpiTransportError>((resolve) => transport.onDisconnect(resolve));
      host.stop();
      const error = await gone;
      expect(error.code).toBe("transport_gone");
    } finally {
      await transport.dispose();
    }
  });
});

describe("client declaration", () => {
  test("the first set_client_info frame declares interactive_user and question", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      expect(host.connections).toHaveLength(2);
      for (const connection of host.connections) {
        expect(connection.frames[0]?.type).toBe("get_protocol_info");
        expect(connection.frames[1]?.type).toBe("set_client_info");
        const declared = connection.frames[1]?.capabilities as string[];
        expect(declared).toContain("interactive_user");
        expect(declared).toContain("question");
      }

      await transport.openSession({ cwd: host.dir });
      const openFrame = host.framesOfType("open_session")[0]?.frame;
      expect(openFrame?.retain_on_disconnect).toBe(true);
      expect(openFrame?.cwd).toBe(host.dir);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("abort with intent stop without interactive_user maps to stop_requires_interactive_client", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir, capabilities: [] });
    try {
      await transport.connect();
      const error = await transport.abort({ intent: "stop" }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("stop_requires_interactive_client");
      expect(host.framesOfType("abort")[0]?.frame.intent).toBe("stop");
    } finally {
      await transport.dispose();
      host.stop();
    }
  });
});

describe("module surface", () => {
  test("AttachClient is reachable from the resolved package root", async () => {
    const AttachClient = await loadAttachClient();
    expect(typeof AttachClient).toBe("function");
  });

  test("importing the transport emits no extension_ui_request on stdout", async () => {
    const child = Bun.spawn([process.execPath, join("test", "senpi", "no-ui-request-spy.ts")], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout.trim()) as { offending: string[]; hasTransport: boolean };
    expect(parsed.offending).toEqual([]);
    expect(parsed.hasTransport).toBe(true);
  });
});
