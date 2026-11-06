// The host never titles a session that already carries context (its `hasContextMessages` gate returns
// before `open_session.auto_title` is even consulted), and the extension injects rules as
// `custom_message` at session creation - so every real session reaches that gate already closed. The
// bridge names such a session itself: one short summarization turn, then `session.renamed`.

export const TITLE_WORKER_FILE = "title-worker.jsonl";

const TITLE_MAX_LENGTH = 60;
const TITLE_INPUT_LIMIT = 2000;

const TITLE_INSTRUCTION =
  "Summarize this coding session as a short title: at most 6 words, in the language of the message. " +
  "Reply with the title alone - no quotes, no markdown, no trailing punctuation, no explanation.";

export function titlePromptFor(firstMessage: string): string {
  return `${TITLE_INSTRUCTION}\n\n<first-message>\n${firstMessage.slice(0, TITLE_INPUT_LIMIT)}\n</first-message>`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text") continue;
    if (typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

function messageRole(entry: Record<string, unknown>): { role: string; text: string } | undefined {
  const message = entry.message;
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role === undefined) return undefined;
  return { role, text: textOfContent(record.content) };
}

/** The first thing the user asked, which is what a title summarizes. */
export function firstUserMessageText(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = messageRole(record);
    if (message?.role !== "user") continue;
    const text = message.text.trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/** The summarization turn's answer: the last assistant text in the worker transcript. */
export function titleFromEntries(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const message = record.type === "message" ? messageRole(record) : undefined;
    if (message !== undefined && message.role !== "assistant") continue;
    const text = message === undefined ? (typeof record.text === "string" ? record.text : "") : message.text;
    const title = normalizeTitle(text);
    if (title !== undefined) return title;
  }
  return undefined;
}

export function normalizeTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw
    .replace(/<[^>]*>/gu, " ")
    .replace(/["'`*#]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.。!！,，;；:：]+$/u, "")
    .trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.toLowerCase() === "none") return undefined;
  return cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH).trim() : cleaned;
}
