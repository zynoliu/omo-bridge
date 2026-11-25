import { randomBytes } from "node:crypto";

export class PtyUnavailable extends Error {
  constructor(detail: string) {
    super("PTY_UNAVAILABLE: " + detail);
    this.name = "PtyUnavailable";
  }
}

export type PtySurfaceOptions = {
  readonly socketPath: string | null;
  readonly tokenTtlMs?: number;
  readonly now?: () => number;
};

export type PtyToken = { readonly token: string; readonly socket: string; readonly expiresAt: number };

export type PtySurface = {
  readonly pty: {
    readonly create: (input?: { readonly title?: string }) => Promise<{ readonly id: string }>;
  };
  readonly experimental: {
    readonly persistentPty: {
      readonly connectToken: () => Promise<PtyToken>;
    };
  };
};

export function createPtySurface(options: PtySurfaceOptions): PtySurface {
  const ttl = options.tokenTtlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  let counter = 0;

  return {
    pty: {
      async create(input) {
        if (input?.title !== undefined && input.title.length > 200) throw new PtyUnavailable("title too long");
        counter += 1;
        return { id: "pty_" + String(counter).padStart(4, "0") };
      },
    },
    experimental: {
      persistentPty: {
        async connectToken() {
          if (options.socketPath === null) throw new PtyUnavailable("no persistent terminal socket is configured");
          return {
            token: randomBytes(16).toString("hex"),
            socket: options.socketPath,
            expiresAt: now() + ttl,
          };
        },
      },
    },
  };
}
