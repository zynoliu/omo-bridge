import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BridgeLaunchUsageError, hostStop, launchBridgeTui, liveStatusEffect, openBridgeTransport, parseBridgeLaunchArgs, routeInboundFrame } from "../src/bridge-run.ts"

function options(directory: string) {
  return {
    socket: path.join(directory, "absent.sock"),
    keyRecord: path.join(directory, "agent", "rpc", "keys", "launch"),
    cwd: directory,
    mini: false,
    handshakeTimeoutMs: 2_000,
  }
}

describe("inbound frame routing", () => {
  function recorder() {
    const published: Record<string, unknown>[] = []
    const answers: string[] = []
    return {
      published: published,
      answers: answers,
      plan: {
        acceptExtensionAnswer: (id: string) => answers.push(id),
        publish: (frame: Record<string, unknown>) => published.push(frame),
      },
    }
  }

  test("a host dialog request is published as host state, never consumed as an extension answer", () => {
    const rec = recorder()
    const select = {
      type: "extension_ui_request",
      id: "ui-permission-1",
      method: "select",
      title: "Permission required: write /workspace/a.txt",
      options: ["Allow once", "Deny"],
    }
    const resolved = { type: "question_resolved", id: "resolve-1", requestId: "ask-1", outcome: "cancelled" }
    routeInboundFrame(select, rec.plan)
    routeInboundFrame(resolved, rec.plan)
    /* the dialog's own id must not read as an answer correlation: it is the request, not the reply */
    expect(rec.answers).toEqual([])
    expect(rec.published.map((frame) => frame.id)).toEqual(["ui-permission-1", "resolve-1"])
  })

  test("a response no request table claimed reaches the extension correlator with its id", () => {
    const rec = recorder()
    routeInboundFrame({ type: "response", id: "extension-7", success: true }, rec.plan)
    expect(rec.answers).toEqual(["extension-7"])
    expect(rec.published).toEqual([])

    /* an answer without a correlation id is still host traffic and is published rather than dropped */
    routeInboundFrame({ type: "response", success: true }, rec.plan)
    expect(rec.answers).toEqual(["extension-7"])
    expect(rec.published.length).toBe(1)
  })
})

describe("host turn stop reasons", () => {
  test("an aborted turn keeps the client's interrupted shape", () => {
    expect(hostStop({ stopReason: "aborted" }, "messages[1]")).toEqual({
      finish: "error",
      error: { type: "aborted", message: "Step interrupted" },
    })
  })

  test("a normal stop is a completed turn with no error", () => {
    expect(hostStop({ stopReason: "stop" }, "messages[1]")).toEqual({ finish: "stop" })
  })

  test("a failed request keeps the host's own message", () => {
    expect(hostStop({ stopReason: "error", errorMessage: "Model is unavailable." }, "messages[2]")).toEqual({
      finish: "error",
      error: { type: "provider.unavailable", message: "Model is unavailable.", status: 400 },
    })
  })
})

describe("live status transitions", () => {
  const status = (value: string) => ({
    routingId: "rpc-1",
    durableId: "session-1",
    directory: "/workspace/probe",
    status: value,
    model: undefined,
  })

  test("a running row settles only when the host reports a quiet state", () => {
    expect(liveStatusEffect("active", status("idle"))).toBe("settled")
    expect(liveStatusEffect("idle", status("idle"))).toBe("steady")
    expect(liveStatusEffect(undefined, status("idle"))).toBe("steady")
    expect(liveStatusEffect("idle", status("running"))).toBe("started")
    expect(liveStatusEffect("active", status("running"))).toBe("steady")
  })
})

describe("bridge launcher state machine", () => {
  test("a failed dial is reported as failed, never as ready", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-run-dial-"))
    try {
      const transport = await openBridgeTransport(options(directory))
      expect(transport.report.state).toBe("failed")
      expect(transport.report.code).toBe("dial_failed")
      transport.close()

      const launched = await launchBridgeTui(options(directory))
      expect(launched.state).toBe("failed")
      expect(launched.state).not.toBe("authenticated")
      expect(launched.code).toBe("dial_failed")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("the launcher refuses an invocation without an explicit key record", () => {
    expect(() => parseBridgeLaunchArgs(["--socket", "/tmp/s.sock"])).toThrow(BridgeLaunchUsageError)
    expect(() => parseBridgeLaunchArgs(["--key-record", "/tmp/key"])).toThrow(BridgeLaunchUsageError)
    expect(() => parseBridgeLaunchArgs(["--socket", "/tmp/s.sock", "--key-record", "/tmp/key", "--extra"])).toThrow(
      BridgeLaunchUsageError,
    )
    const parsed = parseBridgeLaunchArgs(["--socket", "/tmp/s.sock", "--key-record", "/tmp/key", "--mini"])
    expect(parsed.socket).toBe("/tmp/s.sock")
    expect(parsed.keyRecord).toBe("/tmp/key")
    expect(parsed.mini).toBe(true)
  })
})
