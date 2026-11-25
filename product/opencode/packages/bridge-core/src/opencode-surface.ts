import type { BridgeData, ViewSession } from "./data.ts";

export class SurfaceNotFound extends Error {
  readonly id: string;
  constructor(id: string) {
    super("NOT_FOUND: " + id);
    this.name = "SurfaceNotFound";
    this.id = id;
  }
}

export type SessionSurface = {
  readonly session: {
    readonly list: () => Promise<readonly ViewSession[]>;
    readonly get: (input: { readonly id: string }) => Promise<ViewSession>;
  };
  readonly message: {
    readonly list: (input: { readonly sessionID: string }) => Promise<readonly { readonly id: string; readonly text: string }[]>;
  };
};

export function createSessionSurface(data: BridgeData): SessionSurface {
  return {
    session: {
      async list() {
        return data.view().sessions;
      },
      async get(input) {
        const session = data.view().sessions.find((candidate) => candidate.id === input.id);
        if (!session) throw new SurfaceNotFound(input.id);
        return session;
      },
    },
    message: {
      async list(input) {
        const view = data.view();
        if (!view.sessions.some((session) => session.id === input.sessionID)) throw new SurfaceNotFound(input.sessionID);
        const text = view.message.text;
        return text.length === 0 ? [] : [{ id: (view.message.messageId ?? "msg_current") as string, text: text }];
      },
    },
  };
}
