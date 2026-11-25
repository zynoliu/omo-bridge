import { ConfigError } from "./state.ts";

export type HostModel = {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevels: readonly string[];
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ConfigError("INVALID_NAME", "model." + field);
  return value;
}

export function projectModels(raw: unknown): readonly HostModel[] {
  if (!Array.isArray(raw)) throw new ConfigError("INVALID_NAME", "models");
  const seen = new Set<string>();
  const models: HostModel[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError("INVALID_NAME", "model.entry");
    }
    const record = entry as Record<string, unknown>;
    const provider = requireString(record.provider, "provider");
    const id = requireString(record.id, "id");
    const key = provider + "/" + id;
    if (seen.has(key)) throw new ConfigError("INVALID_NAME", "model.duplicate:" + key);
    seen.add(key);
    const levels = Array.isArray(record.thinkingLevels)
      ? record.thinkingLevels.filter((level): level is string => typeof level === "string" && level.length > 0)
      : [];
    models.push({ provider: provider, id: id, thinkingLevels: levels });
  }
  return models;
}

export type ModelSelection = { readonly model: HostModel; readonly qualified: string };

export function selectModel(models: readonly HostModel[], requested: string): ModelSelection {
  const match = models.find((model) => model.provider + "/" + model.id === requested || model.id === requested);
  if (!match) throw new ConfigError("UNKNOWN_MODEL", requested + " (host offered " + String(models.length) + ")");
  return { model: match, qualified: match.provider + "/" + match.id };
}

export function assertNonEmpty(models: readonly HostModel[], context: string): void {
  if (models.length === 0) {
    throw new ConfigError("UNKNOWN_MODEL", context + ": the host offered no models, likely because no provider credential is configured");
  }
}
