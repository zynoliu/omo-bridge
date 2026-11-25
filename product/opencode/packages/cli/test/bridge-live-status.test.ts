import { describe, expect, test } from "bun:test";

import { SessionRegistry } from "../../bridge-core/src/sessions.ts";
import { applyLiveStatus } from "../src/bridge-run.ts";

const STATUS = {
  routingId: "rpc-1",
  durableId: "durable-1",
  directory: "/workspace/bridge",
  model: undefined,
} as const;

function registryWithSession(): SessionRegistry {
  const sessions = new SessionRegistry();
  sessions.open({ persistentId: "persistent-1", durableId: "durable-1" });
  return sessions;
}

describe("live session status", () => {
  test("a running frame marks the row active and a later idle frame clears it", () => {
    const sessions = registryWithSession();
    applyLiveStatus(sessions, { ...STATUS, status: "running" });
    expect(sessions.list()[0]?.state).toBe("active");
    applyLiveStatus(sessions, { ...STATUS, status: "idle" });
    expect(sessions.list()[0]?.state).toBe("idle");
  });

  test("waiting_input and compacting count as running, an unknown status does not", () => {
    const sessions = registryWithSession();
    for (const status of ["waiting_input", "compacting"]) {
      applyLiveStatus(sessions, { ...STATUS, status: "idle" });
      applyLiveStatus(sessions, { ...STATUS, status: status });
      expect(sessions.list()[0]?.state).toBe("active");
    }
    applyLiveStatus(sessions, { ...STATUS, status: undefined });
    expect(sessions.list()[0]?.state).toBe("idle");
  });

  test("a frame for a session this process never opened changes nothing", () => {
    const sessions = registryWithSession();
    applyLiveStatus(sessions, { ...STATUS, durableId: "durable-unknown", status: "running" });
    expect(sessions.list().map((record) => record.state)).toEqual(["idle"]);
  });
});
