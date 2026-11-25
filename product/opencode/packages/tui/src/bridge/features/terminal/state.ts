/* Panel-facing model for a same-machine PTY: the bytes the pty emits become whole lines the panel can draw. Cell layout (wrapping, wide characters, scrolling regions) belongs to the renderable that draws these lines, so this model never reflows and never guesses a display width. */

export type TerminalSize = { readonly cols: number; readonly rows: number };

export type TerminalScreen = {
  readonly lines: readonly string[];
  readonly partial: string;
  /* an escape sequence split across chunks is held here until it terminates */
  readonly escape: string;
  /* a carriage return is only a column reset when the next character is not the newline of a CRLF pair */
  readonly carriageReturn: boolean;
};

export type TerminalScreenState = TerminalScreen;

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

export const EMPTY_TERMINAL_SCREEN: TerminalScreen = { lines: [], partial: "", escape: "", carriageReturn: false };

const MAX_SCREEN_LINES = 400;
const MAX_ESCAPE_LENGTH = 64;

export type TerminalRefusalCode =
  | "invalid-session"
  | "invalid-cwd"
  | "cwd-unavailable"
  | "cwd-reaches-home"
  | "invalid-env"
  | "env-home-uncontrolled"
  | "invalid-shell"
  | "shell-unavailable"
  | "invalid-size"
  | "unknown-terminal"
  | "session-mismatch"
  | "terminal-closed";

export type TerminalRefusal = {
  readonly kind: "refused";
  readonly code: TerminalRefusalCode;
  readonly message: string;
};

export function refuse(code: TerminalRefusalCode, message: string): TerminalRefusal {
  return { kind: "refused", code: code, message: message };
}

/** Reads a pty chunk into the screen: `\r\n` ends a line, a lone `\r` returns to column zero, `\n` ends a line, `\b` rubs out one character, and control sequences are dropped. */
export function applyOutput(screen: TerminalScreen, text: string): TerminalScreen {
  const next = {
    lines: screen.lines.slice(),
    partial: screen.partial,
    escape: screen.escape,
    carriageReturn: screen.carriageReturn,
  };
  for (const char of text) {
    if (next.escape.length > 0) {
      next.escape += char;
      if (!terminatedEscape(next.escape) && next.escape.length <= MAX_ESCAPE_LENGTH) continue;
      next.escape = "";
      continue;
    }
    if (char === "\u001b") {
      next.escape = "\u001b";
      continue;
    }
    if (char === "\r") {
      next.carriageReturn = true;
      continue;
    }
    if (char === "\n") {
      next.lines.push(next.partial);
      next.partial = "";
      next.carriageReturn = false;
      continue;
    }
    if (next.carriageReturn) {
      next.partial = "";
      next.carriageReturn = false;
    }
    if (char === "\b") {
      next.partial = next.partial.slice(0, -1);
      continue;
    }
    if (char === "\t") {
      next.partial += "        ".slice(0, 8 - (next.partial.length % 8));
      continue;
    }
    if (char < " ") continue;
    next.partial += char;
  }
  const lines = next.lines.length > MAX_SCREEN_LINES ? next.lines.slice(next.lines.length - MAX_SCREEN_LINES) : next.lines;
  return { lines: lines, partial: next.partial, escape: next.escape, carriageReturn: next.carriageReturn };
}

export function screenText(screen: TerminalScreen): string {
  return screen.lines.concat(screen.partial).join("\n");
}

export function isEmptyScreen(screen: TerminalScreen): boolean {
  return screen.lines.length === 0 && screen.partial === "";
}

export function clampSize(size: TerminalSize | undefined): TerminalSize | null {
  const held = size ?? DEFAULT_TERMINAL_SIZE;
  if (!Number.isInteger(held.cols) || !Number.isInteger(held.rows)) return null;
  if (held.cols < 1 || held.rows < 1 || held.cols > 1000 || held.rows > 1000) return null;
  return { cols: held.cols, rows: held.rows };
}

function terminatedEscape(sequence: string): boolean {
  if (sequence.length < 2) return false;
  const kind = sequence.charAt(1);
  if (kind === "[") return sequence.length > 2 && finalByte(sequence.charCodeAt(sequence.length - 1));
  if (kind === "]") return sequence.endsWith("\u0007") || sequence.endsWith("\u001b\\");
  return true;
}

function finalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}
