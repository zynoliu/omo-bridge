import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError } from "./state.ts";

export type LocalSettingsOptions = {
  readonly root: string;
  readonly allowedKeys: readonly string[];
};

export class LocalSettings {
  private readonly root: string;
  private readonly allowed: Set<string>;

  constructor(options: LocalSettingsOptions) {
    const stat = fs.lstatSync(options.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConfigError("UNAUTHORIZED_WRITE", "settings root must be an owned plain directory");
    }
    this.root = options.root;
    this.allowed = new Set(options.allowedKeys);
  }

  file(): string {
    return path.join(this.root, "settings.json");
  }

  read(): Readonly<Record<string, string>> {
    const file = this.file();
    let handle: number;
    try {
      handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile()) throw new ConfigError("UNAUTHORIZED_WRITE", "settings file is not a regular file");
      const parsed = JSON.parse(fs.readFileSync(handle, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError("UNAUTHORIZED_WRITE", "settings file is not an object");
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } finally {
      fs.closeSync(handle);
    }
  }

  write(key: string, value: string, guard: { readonly authorized: boolean }): Readonly<Record<string, string>> {
    if (!guard.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "local." + key);
    if (!this.allowed.has(key)) throw new ConfigError("INVALID_NAME", "local." + key);
    const next = { ...this.read(), [key]: value };
    const file = this.file();
    const temp = path.join(this.root, ".settings." + String(process.pid) + ".tmp");
    const handle = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(handle, JSON.stringify(next, null, 2) + "\n");
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temp, file);
    return next;
  }
}
