import { ConfigError } from "./state.ts";

export type McpScope = "client" | "host";

export type McpSurface = {
  readonly client: readonly string[];
  readonly host: readonly string[];
};

export class SurfaceState {
  private commandList: string[] = [];
  private client: string[] = [];
  private host: string[] = [];

  commands(): readonly string[] {
    return [...this.commandList];
  }

  setCommands(names: readonly string[], guard: { readonly authorized: boolean }): readonly string[] {
    if (!guard.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "commands");
    this.commandList = names.filter((name) => name.length > 0);
    return this.commands();
  }

  mcp(): McpSurface {
    return { client: [...this.client], host: [...this.host] };
  }

  addMcp(scope: McpScope, name: string, guard: { readonly authorized: boolean }): McpSurface {
    if (!guard.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "mcp." + scope);
    if (name.length === 0) throw new ConfigError("INVALID_NAME", "mcp." + scope);
    if (scope === "client") {
      if (!this.client.includes(name)) this.client = [...this.client, name];
    } else if (!this.host.includes(name)) {
      this.host = [...this.host, name];
    }
    return this.mcp();
  }

  removeMcp(scope: McpScope, name: string, guard: { readonly authorized: boolean }): McpSurface {
    if (!guard.authorized) throw new ConfigError("UNAUTHORIZED_WRITE", "mcp." + scope);
    if (scope === "client") this.client = this.client.filter((entry) => entry !== name);
    else this.host = this.host.filter((entry) => entry !== name);
    return this.mcp();
  }

  isRegisteredOnlyOn(scope: McpScope, name: string): boolean {
    const inClient = this.client.includes(name);
    const inHost = this.host.includes(name);
    return scope === "client" ? inClient && !inHost : inHost && !inClient;
  }
}
