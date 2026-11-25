import { describe, expect, test } from "bun:test";

import { InteractionController } from "../src/interaction.ts";

describe("InteractionController", () => {
  test("queued steer and follow_up input from a running turn carries into the next turn", () => {
    const controller = new InteractionController();
    const first = controller.startTurn();
    expect(controller.submit(first, "steer", "be brief").kind).toBe("accepted");
    expect(controller.submit(first, "follow_up", "then test").kind).toBe("accepted");
    controller.completeTurn(first);
    const second = controller.startTurn();
    const queued = controller.pendingQueue();
    expect(queued.length).toBe(2);
    expect(queued.every((input) => input.turn === second)).toBe(true);
  });

  test("abort clears the queue and marks the turn aborted", () => {
    const controller = new InteractionController();
    const turn = controller.startTurn();
    controller.submit(turn, "steer", "x");
    expect(controller.abort(turn).kind).toBe("accepted");
    expect(controller.pendingQueue().length).toBe(0);
    expect(controller.state().activeTurn).toBeNull();
    expect(controller.state().abortedTurns).toContain(turn);
  });

  test("interrupt keeps the session and its queue", () => {
    const controller = new InteractionController();
    const turn = controller.startTurn();
    controller.submit(turn, "steer", "y");
    expect(controller.interrupt(turn).kind).toBe("accepted");
    expect(controller.pendingQueue().length).toBe(1);
    expect(controller.state().activeTurn).toBe(turn);
  });

  test("a stale turn cannot change the session", () => {
    const controller = new InteractionController();
    const turn = controller.startTurn();
    controller.abort(turn);
    const next = controller.startTurn();
    const stale = controller.submit(turn, "steer", "late");
    expect(stale.kind === "rejected" && stale.code).toBe("STALE_TURN");
    expect(controller.pendingQueue().length).toBe(0);
    expect(controller.state().activeTurn).toBe(next);
  });

  test("an unknown model is reported rather than stored", () => {
    const controller = new InteractionController();
    const result = controller.switchModel("not-a-model", { known: false, authorized: true });
    expect(result.kind === "rejected" && result.code).toBe("UNKNOWN_MODEL");
    expect(controller.state().model).toBeNull();
  });

  test("an unauthorised model switch is refused with its own code", () => {
    const controller = new InteractionController();
    const result = controller.switchModel("some-model", { known: true, authorized: false });
    expect(result.kind === "rejected" && result.code).toBe("UNAUTHORIZED_MODEL_SWITCH");
  });

  test("thinking level and permission preset are tracked and validated", () => {
    const controller = new InteractionController();
    expect(controller.setThinkingLevel("high").kind).toBe("accepted");
    expect(controller.setThinkingLevel("maximum").kind === "rejected").toBe(true);
    expect(controller.setPermissionPreset("ask").kind).toBe("accepted");
    expect(controller.state().thinkingLevel).toBe("high");
    expect(controller.state().permissionPreset).toBe("ask");
  });

  test("prompt cannot be queued into a running turn as a steer", () => {
    const controller = new InteractionController();
    const turn = controller.startTurn();
    expect(controller.submit(turn, "prompt", "new turn please").kind).toBe("rejected");
  });

  test("submitting without an active turn is refused explicitly", () => {
    const controller = new InteractionController();
    const result = controller.submit("turn_0001", "steer", "x");
    expect(result.kind === "rejected" && result.code).toBe("NO_ACTIVE_TURN");
  });
});
