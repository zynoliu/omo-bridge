/**
 * The `agent` / `agents` selection a client prompt can name (capability row P-685).
 *
 * The client's `session.prompt` input can name an agent: the current shape carries subagent
 * attachments as `agents`, and older clients carried a single `agent` id. The host's `prompt` command
 * has neither, and the launcher's command set has no agent or profile switch to map onto
 * (`upstream/senpi/.../docs/rpc.md`, command inventory: `prompt`, `steer`, `follow_up`, `set_model`,
 * `set_thinking_level`, `set_session_context`, ... none selects an agent). Refusing the field lost the
 * request; this module translates it instead:
 *
 * - the prompt text gains one documented instruction that names the requested agent and says the host
 *   switched nothing;
 * - the translation travels back to the caller so the session can record it.
 *
 * Nothing here claims an agent ran. No host command is given the name, and the record it returns says
 * `hostField: false` for exactly that reason.
 */

export const AGENT_REQUEST_MARKER = "[agent request]";

export type PromptAgentSelection = {
  /** The names the caller asked for, in the order they were given, without duplicates. */
  readonly requested: readonly string[];
  readonly carrier: "prompt-prefix";
  readonly hostField: false;
};

export type PromptTranslation = {
  /** The text to send: the original prompt, prefixed only when a selection was named. */
  readonly text: string;
  /** Absent when the prompt named no agent, which is the composer's default (`agents: []`). */
  readonly selection: PromptAgentSelection | undefined;
};

export function translatePromptAgentSelection(input: unknown): PromptTranslation {
  if (typeof input !== "object" || input === null) return { text: "", selection: undefined };
  const record = input as Readonly<Record<string, unknown>>;
  const text = typeof record.text === "string" ? record.text : "";
  const requested = requestedAgents(record);
  if (requested.length === 0) return { text: text, selection: undefined };
  const selection: PromptAgentSelection = { requested: requested, carrier: "prompt-prefix", hostField: false };
  return { text: agentInstruction(requested) + "\n\n" + text, selection: selection };
}

function requestedAgents(record: Readonly<Record<string, unknown>>): readonly string[] {
  const names: string[] = [];
  const single = record.agent;
  if (typeof single === "string" && single.length > 0) names.push(single);
  const attachments = record.agents;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const name =
        typeof attachment === "string"
          ? attachment
          : typeof attachment === "object" && attachment !== null
            ? (attachment as Readonly<Record<string, unknown>>).name
            : undefined;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return [...new Set(names)];
}

/**
 * The one line a prompt carries when it names an agent. It is phrased as an instruction to the model
 * because that is what it is: nothing on the host changed, and the model is the only reader.
 */
export function agentInstruction(requested: readonly string[]): string {
  const names = requested.map((name) => '"' + name + '"').join(", ");
  return (
    AGENT_REQUEST_MARKER +
    " The client asked for agent " +
    names +
    ". The host prompt command carries no agent field and the bridge switched no agent; this instruction is the only carrier of that request. Act in that role for this turn if it differs from yours."
  );
}
