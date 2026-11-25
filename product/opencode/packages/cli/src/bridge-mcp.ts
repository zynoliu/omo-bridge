/**
 * The TUI half of the client-MCP seam, composed at bridge startup.
 *
 * The companion extension asks this process to run one MCP tool call by publishing a
 * `tui.pack.mcp.request` extension event; the client in `tui/src/bridge/mcp-client.ts` answers with
 * `tui.pack.mcp.reply` over the same transport. This module owns the only part the launcher has to
 * supply: what a `tui` tool call actually does.
 *
 * The tool names and meanings are the fork's own client server (`packages/tui/src/context/
 * client-mcp.tsx`): `open_terminal` opens a terminal for the calling session without taking keyboard
 * focus, and `write_terminal` types text into it. Terminals come from the fork's persistent PTY
 * service, which the launcher already runs in this process, so nothing here spawns a shell of its own.
 */
import { ptySessionID } from "../../bridge-core/src/opencode-api.ts";
import type { McpRequest } from "../../tui/src/bridge/mcp-client.ts";
import type { BridgePty, PtyInfo } from "./bridge-pty";

export type BridgeMcpOutcome = { readonly result: unknown } | { readonly error: string };

const TUI_SERVER = "tui";

export function createBridgeMcpExecutor(pty: BridgePty | undefined): (request: McpRequest) => Promise<BridgeMcpOutcome> {
  return async (request) => {
    if (pty === undefined) return { error: "this bridge runs no terminal service, so it serves no client MCP tools" };
    if (request.server !== TUI_SERVER) return { error: "the bridge serves only the '" + TUI_SERVER + "' client server" };
    if (request.sessionID === undefined) return { error: "the request names no session" };
    if (request.tool === "open_terminal") return await openTerminal(pty, request.sessionID);
    if (request.tool === "write_terminal") return await writeTerminal(pty, request.sessionID, request.input);
    return { error: "unknown tool " + request.tool + " on the '" + TUI_SERVER + "' client server" };
  };
}

/** The session's newest terminal, or a fresh one. Detached: the agent opened it, not the user. */
async function terminalFor(pty: BridgePty, sessionID: string): Promise<PtyInfo> {
  const session = ptySessionID(sessionID);
  const existing = await pty.list(session);
  const newest = existing.at(-1);
  if (newest !== undefined) return newest;
  return await pty.create(session, {
    command: process.env.SHELL ?? "/bin/sh",
    args: [],
    cwd: process.cwd(),
    title: "bridge",
    env: {},
  });
}

async function openTerminal(pty: BridgePty, sessionID: string): Promise<BridgeMcpOutcome> {
  const opened = await terminalFor(pty, sessionID);
  return { result: { content: [{ type: "text", text: "Opened terminal " + opened.id }] } };
}

async function writeTerminal(pty: BridgePty, sessionID: string, input: unknown): Promise<BridgeMcpOutcome> {
  const text = typeof input === "object" && input !== null && "text" in input ? (input as { text?: unknown }).text : undefined;
  if (typeof text !== "string") return { error: "text must be a string" };
  const terminal = await terminalFor(pty, sessionID);
  await pty.write(terminal.id, text);
  return { result: { content: [{ type: "text", text: "Wrote to terminal " + terminal.id }] } };
}
