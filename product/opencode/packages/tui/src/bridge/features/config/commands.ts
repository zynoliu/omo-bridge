import { ConfigError } from "./state.ts";

export type HostCommandSource = {
  readonly path: string;
  readonly source: string;
  readonly scope: string;
  readonly origin: string;
};

export type ProjectedCommand = {
  readonly name: string;
  readonly description: string;
  readonly source: SourceEcho;
};

type SourceEcho = HostCommandSource;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ConfigError("INVALID_NAME", "command." + field);
  return value;
}

export function projectCommands(hostCommands: unknown): readonly ProjectedCommand[] {
  if (!Array.isArray(hostCommands)) throw new ConfigError("INVALID_NAME", "commands");
  const seen = new Set<string>();
  const projected: ProjectedCommand[] = [];
  for (const entry of hostCommands) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError("INVALID_NAME", "command.entry");
    }
    const record = entry as Record<string, unknown>;
    const name = requireString(record.name, "name");
    if (seen.has(name)) throw new ConfigError("INVALID_NAME", "command.duplicate:" + name);
    seen.add(name);
    const description = typeof record.description === "string" ? record.description : "";
    const rawSource = record.sourceInfo;
    let source: ProjectedCommand["source"];
    if (typeof rawSource === "object" && rawSource !== null && !Array.isArray(rawSource)) {
      const info = rawSource as Record<string, unknown>;
      source = {
        path: requireString(info.path, "sourceInfo.path"),
        source: requireString(info.source, "sourceInfo.source"),
        scope: requireString(info.scope, "sourceInfo.scope"),
        origin: requireString(info.origin, "sourceInfo.origin"),
      };
    } else {
      throw new ConfigError("INVALID_NAME", "command.sourceInfo:" + name);
    }
    projected.push({ name: name, description: description, source: source });
  }
  return projected;
}
