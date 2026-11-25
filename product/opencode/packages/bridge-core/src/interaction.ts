export type InputKind = "prompt" | "steer" | "follow_up";
export type TurnId = string;

export type InteractionFailure =
  | "STALE_TURN"
  | "UNKNOWN_TURN"
  | "NO_ACTIVE_TURN"
  | "UNKNOWN_MODEL"
  | "UNAUTHORIZED_MODEL_SWITCH"
  | "UNSUPPORTED_THINKING_LEVEL";

export type QueuedInput = { readonly turn: TurnId; readonly kind: InputKind; readonly text: string };

export type InteractionState = {
  readonly activeTurn: TurnId | null;
  readonly queue: readonly QueuedInput[];
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly permissionPreset: string | null;
  readonly abortedTurns: readonly TurnId[];
};

export type Accepted<T> = { readonly kind: "accepted"; readonly value: T };
export type Rejected = { readonly kind: "rejected"; readonly code: InteractionFailure };
export type Outcome<T> = Accepted<T> | Rejected;

function accepted<T>(value: T): Accepted<T> {
  return { kind: "accepted", value: value };
}

function rejected(code: InteractionFailure): Rejected {
  return { kind: "rejected", code: code };
}

/** The host's documented vocabulary; a model offers a subset, reported by `get_available_thinking_levels`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class InteractionController {
  private activeTurn: TurnId | null = null;
  private queue: QueuedInput[] = [];
  private model: string | null = null;
  private thinkingLevel: string | null = null;
  private permissionPreset: string | null = null;
  private readonly abortedTurns: TurnId[] = [];
  private counter = 0;

  state(): InteractionState {
    return {
      activeTurn: this.activeTurn,
      queue: [...this.queue],
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      permissionPreset: this.permissionPreset,
      abortedTurns: [...this.abortedTurns],
    };
  }

  startTurn(): TurnId {
    this.counter += 1;
    this.activeTurn = "turn_" + String(this.counter).padStart(4, "0");
    this.queue = this.queue.map((input) => ({ ...input, turn: this.activeTurn as TurnId }));
    return this.activeTurn;
  }

  submit(turn: TurnId, kind: InputKind, text: string): Outcome<TurnId | QueuedInput> {
    if (this.abortedTurns.includes(turn)) return rejected("STALE_TURN");
    if (this.activeTurn === null) return rejected("NO_ACTIVE_TURN");
    if (turn !== this.activeTurn) return rejected("UNKNOWN_TURN");
    if (kind === "prompt") return rejected("UNKNOWN_TURN");
    const queued: QueuedInput = { turn: turn, kind: kind, text: text };
    this.queue.push(queued);
    return accepted(queued);
  }

  interrupt(turn: TurnId): Outcome<TurnId> {
    if (this.abortedTurns.includes(turn)) return rejected("STALE_TURN");
    if (turn !== this.activeTurn) return rejected("UNKNOWN_TURN");
    return accepted(turn);
  }

  abort(turn: TurnId): Outcome<TurnId> {
    if (this.abortedTurns.includes(turn)) return rejected("STALE_TURN");
    if (turn !== this.activeTurn) return rejected("UNKNOWN_TURN");
    this.abortedTurns.push(turn);
    this.queue = [];
    this.activeTurn = null;
    return accepted(turn);
  }

  completeTurn(turn: TurnId): Outcome<TurnId> {
    if (turn !== this.activeTurn) return rejected("UNKNOWN_TURN");
    this.activeTurn = null;
    return accepted(turn);
  }

  pendingQueue(): readonly QueuedInput[] {
    return [...this.queue];
  }

  switchModel(model: string, options: { readonly known: boolean; readonly authorized: boolean }): Outcome<string> {
    if (!options.authorized) return rejected("UNAUTHORIZED_MODEL_SWITCH");
    if (!options.known) return rejected("UNKNOWN_MODEL");
    this.model = model;
    return accepted(model);
  }

  setThinkingLevel(level: string): Outcome<string> {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) return rejected("UNSUPPORTED_THINKING_LEVEL");
    this.thinkingLevel = level;
    return accepted(level);
  }

  setPermissionPreset(preset: string): Outcome<string> {
    this.permissionPreset = preset;
    return accepted(preset);
  }
}
