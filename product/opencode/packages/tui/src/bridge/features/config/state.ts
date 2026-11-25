export type ConfigFailure =
  | "INVALID_PRESET"
  | "UNAUTHORIZED_WRITE"
  | "UNKNOWN_MODEL"
  | "UNSUPPORTED_THINKING_LEVEL"
  | "INVALID_NAME";

export class ConfigError extends Error {
  readonly code: ConfigFailure;
  constructor(code: ConfigFailure, detail: string) {
    super(code + (detail.length === 0 ? "" : ": " + detail));
    this.name = "ConfigError";
    this.code = code;
  }
}

/**
 * The host's documented level vocabulary (`set_thinking_level`). A model offers a subset of it; the
 * subset that applies is read from `get_available_thinking_levels`, never assumed from this list.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type LoadedSurfaces = {
  readonly mcpServers: readonly string[];
  readonly scope: "loaded-only";
  readonly note: string;
};

export type ConfigSnapshot = {
  readonly model: string | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly permissionPreset: string | null;
  readonly local: Readonly<Record<string, string>>;
  readonly reloadCount: number;
};

export type WriteGuard = { readonly authorized: boolean };

export class ConfigState {
  private model: string | null = null;
  private thinkingLevel: ThinkingLevel | null = null;
  private permissionPreset: string | null = null;
  private local: Record<string, string> = {};
  private reloadCount = 0;
  private loaded = new Set<string>();

  snapshot(): ConfigSnapshot {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      permissionPreset: this.permissionPreset,
      local: { ...this.local },
      reloadCount: this.reloadCount,
    };
  }

  setModel(model: string, options: { readonly known: boolean } & WriteGuard): ConfigSnapshot {
    if (!options.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "model");
    if (!options.known) throw new ConfigError("UNKNOWN_MODEL", model);
    this.model = model;
    return this.snapshot();
  }

  setThinkingLevel(level: string, options: WriteGuard & { readonly available?: readonly string[] }): ConfigSnapshot {
    if (!options.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "thinkingLevel");
    const allowed = options.available ?? THINKING_LEVELS;
    if (!(allowed as readonly string[]).includes(level)) {
      throw new ConfigError("UNSUPPORTED_THINKING_LEVEL", level);
    }
    this.thinkingLevel = level as ThinkingLevel;
    return this.snapshot();
  }

  setPermissionPreset(preset: string, options: { readonly allowed: readonly string[] } & WriteGuard): ConfigSnapshot {
    if (!options.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "permissionPreset");
    if (!options.allowed.includes(preset)) throw new ConfigError("INVALID_PRESET", preset);
    this.permissionPreset = preset;
    return this.snapshot();
  }

  setLocal(key: string, value: string, guard: WriteGuard): ConfigSnapshot {
    if (!guard.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "local." + key);
    this.local = { ...this.local, [key]: value };
    return this.snapshot();
  }

  reload(markSurfaces: readonly string[]): ConfigSnapshot {
    this.reloadCount += 1;
    this.loaded = new Set(markSurfaces);
    return this.snapshot();
  }

  loadedSurfaces(): LoadedSurfaces {
    return {
      mcpServers: [...this.loaded],
      scope: "loaded-only",
      note: "this reports only surfaces the host reported as loaded; it is not a full skill or resource catalogue",
    };
  }
}
