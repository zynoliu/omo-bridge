import { describe, expect, test } from "bun:test";

import { SessionRegistry } from "../src/sessions.ts";

describe("SessionRegistry", () => {
  test("open mints a handle distinct from the persistent id", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") return;
    const attached = registry.attach(opened.value);
    expect(attached.kind).toBe("ok");
    if (attached.kind !== "ok") return;
    expect(attached.value.handle).not.toBe(attached.value.persistentId);
  });

  test("reopen returns a new handle for the same persistent identity and keeps history", () => {
    const registry = new SessionRegistry();
    const first = registry.open({ persistentId: "p_x", history: ["m1", "m2"] });
    if (first.kind !== "ok") throw new Error("open failed");
    registry.close(first.value);
    const second = registry.reopen("p_x");
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.value).not.toBe(first.value);
    const history = registry.history(second.value);
    expect(history.kind).toBe("ok");
    if (history.kind !== "ok") return;
    expect(history.value).toEqual(["m1", "m2"]);
  });

  test("unload refuses while a turn is active and does not report success", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    if (opened.kind !== "ok") throw new Error("open failed");
    registry.markActive(opened.value);
    const unloaded = registry.unload(opened.value);
    expect(unloaded.kind).toBe("refused");
    if (unloaded.kind !== "refused") return;
    expect(unloaded.code).toBe("ACTIVE_TURN");
    const attached = registry.attach(opened.value);
    expect(attached.kind).toBe("ok");
    if (attached.kind !== "ok") return;
    expect(attached.value.state).toBe("active");
  });

  test("park and close refuse while an approval is pending", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    if (opened.kind !== "ok") throw new Error("open failed");
    registry.setPendingApproval(opened.value, true);
    expect(registry.park(opened.value).kind).toBe("refused");
    expect(registry.unload(opened.value).kind).toBe("refused");
    expect(registry.close(opened.value).kind).toBe("refused");
  });

  test("park moves an idle session to parked and unload is idempotent for parked", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    if (opened.kind !== "ok") throw new Error("open failed");
    expect(registry.park(opened.value).kind).toBe("ok");
    const again = registry.park(opened.value);
    expect(again.kind).toBe("ok");
  });

  test("closed sessions refuse attach and further operations", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    if (opened.kind !== "ok") throw new Error("open failed");
    registry.close(opened.value);
    const attached = registry.attach(opened.value);
    expect(attached.kind).toBe("refused");
    if (attached.kind !== "refused") return;
    expect(attached.code).toBe("ALREADY_CLOSED");
  });

  test("unknown handles and unknown persistent ids are refused, not silently created", () => {
    const registry = new SessionRegistry();
    const attached = registry.attach("sess_9999");
    expect(attached.kind === "refused" && attached.code).toBe("UNKNOWN_HANDLE");
    const reopened = registry.reopen("p_missing");
    expect(reopened.kind === "refused" && reopened.code).toBe("UNKNOWN_PERSISTENT_ID");
  });

  test("list reports every handle with its own persistent identity", () => {
    const registry = new SessionRegistry();
    const a = registry.open({ persistentId: "p_a" });
    const b = registry.open({ persistentId: "p_b" });
    const listed = registry.list();
    expect(listed.length).toBe(2);
    expect(a.kind === "ok" && b.kind === "ok").toBe(true);
    expect(listed.map((session) => session.persistentId)).toEqual(["p_a", "p_b"]);
  });

  test("a seeded registry reopens a persistent identity it did not open itself", () => {
    const restarted = new SessionRegistry({
      knownPersistentIds: ["p_seeded"],
      historyByPersistentId: { p_seeded: ["h1"] },
    });
    const reopened = restarted.reopen("p_seeded");
    expect(reopened.kind).toBe("ok");
    if (reopened.kind !== "ok") return;
    const history = restarted.history(reopened.value);
    expect(history.kind === "ok" && history.value).toEqual(["h1"]);
  });

  test("park refuses while a turn is active", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({});
    if (opened.kind !== "ok") throw new Error("open failed");
    registry.markActive(opened.value);
    const parked = registry.park(opened.value);
    expect(parked.kind === "refused" && parked.code).toBe("ACTIVE_TURN");
  });

  test("a run handle stays distinct from the durable identity", () => {
    const registry = new SessionRegistry();
    const opened = registry.open({ persistentId: "p_conn", durableId: "01a1e983-durable" });
    if (opened.kind !== "ok") throw new Error("open failed");
    const attached = registry.attach(opened.value);
    if (attached.kind !== "ok") throw new Error("attach failed");
    expect(attached.value.handle).not.toBe(attached.value.durableId);
    expect(attached.value.durableId).toBe("01a1e983-durable");
  });
});
