// One entry per top-level namespace on the client, so every unimplemented namespace can be labelled honestly.
export const CLIENT_API_GROUPS = [
  "agent",
  "command",
  "config",
  "credential",
  "debug",
  "event",
  "experimental",
  "file",
  "form",
  "generate",
  "integration",
  "location",
  "mcp",
  "message",
  "migration",
  "model",
  "permission",
  "plugin",
  "project",
  "provider",
  "pty",
  "reference",
  "rpc",
  "server",
  "session",
  "shell",
  "skill",
  "usage",
  "vcs",
  "voice",
  "websearch",
  "worktree",
] as const;

export type ClientApiGroup = (typeof CLIENT_API_GROUPS)[number];

export class UnimplementedApiGroup extends Error {
  readonly group: ClientApiGroup;
  readonly member: string;
  constructor(group: ClientApiGroup, member: string) {
    super("UNIMPLEMENTED_API_GROUP: " + group + "." + member);
    this.name = "UnimplementedApiGroup";
    this.group = group;
    this.member = member;
  }
}

export type ClientSurfaceStub = {
  readonly group: ClientApiGroup;
  readonly call: (member: string) => never;
};

export function unimplementedGroup(group: ClientApiGroup): ClientSurfaceStub {
  return {
    group: group,
    call: (member: string): never => {
      throw new UnimplementedApiGroup(group, member);
    },
  };
}

export function createClientSurfaceStubs(): readonly ClientSurfaceStub[] {
  return CLIENT_API_GROUPS.map((group) => unimplementedGroup(group));
}
