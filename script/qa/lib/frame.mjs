const ESC = 0x1b;
const BEL = 0x07;

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

export function createScreen(cols = 120, rows = 36) {
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  let row = 0;
  let col = 0;

  const put = (ch) => {
    if (col >= width) {
      col = 0;
      row += 1;
      if (row >= height) {
        grid.shift();
        grid.push(Array.from({ length: width }, () => " "));
        row = height - 1;
      }
    }
    const wide = isWide(ch.codePointAt(0) ?? 0);
    grid[row][col] = ch;
    if (wide && col + 1 < width) grid[row][col + 1] = "";
    col += wide ? 2 : 1;
  };

  const lineFeed = () => {
    row += 1;
    if (row >= height) {
      grid.shift();
      grid.push(Array.from({ length: width }, () => " "));
      row = height - 1;
    }
  };

  const clearLine = (mode) => {
    if (mode === 2) {
      for (let i = 0; i < width; i += 1) grid[row][i] = " ";
      return;
    }
    if (mode === 1) {
      for (let i = 0; i <= col && i < width; i += 1) grid[row][i] = " ";
      return;
    }
    for (let i = col; i < width; i += 1) grid[row][i] = " ";
  };

  const clearScreen = () => {
    for (const line of grid) line.fill(" ");
    row = 0;
    col = 0;
  };

  const handleCsi = (body, final) => {
    const params = body.replace(/^[?>!]/, "").split(";").map((value) => Number.parseInt(value, 10));
    if (final === "H" || final === "f") {
      const targetRow = Number.isFinite(params[0]) && params[0] > 0 ? params[0] - 1 : 0;
      const targetCol = Number.isFinite(params[1]) && params[1] > 0 ? params[1] - 1 : 0;
      row = Math.min(height - 1, Math.max(0, targetRow));
      col = Math.min(width - 1, Math.max(0, targetCol));
      return;
    }
    if (final === "A") row = Math.max(0, row - (params[0] || 1));
    else if (final === "B") row = Math.min(height - 1, row + (params[0] || 1));
    else if (final === "C") col = Math.min(width - 1, col + (params[0] || 1));
    else if (final === "D") col = Math.max(0, col - (params[0] || 1));
    else if (final === "G") col = Math.min(width - 1, Math.max(0, (params[0] || 1) - 1));
    else if (final === "K") clearLine(params[0] || 0);
    else if (final === "J") clearScreen();
  };

  const state = { pending: "", inOsc: false };

  const feed = (text) => {
    let input = state.pending + text;
    state.pending = "";
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      const code = input.charCodeAt(i);
      if (state.inOsc) {
        if (code === BEL) state.inOsc = false;
        else if (ch === "\u001b" && input[i + 1] === "\\") {
          state.inOsc = false;
          i += 1;
        }
        continue;
      }
      if (code === ESC) {
        const next = input[i + 1];
        if (next === undefined) {
          state.pending = input.slice(i);
          return;
        }
        if (next === "]") {
          state.inOsc = true;
          i += 1;
          continue;
        }
        if (next === "[") {
          const match = /^\[([0-9;?><!]*)([@-~])/.exec(input.slice(i + 1));
          if (match === null) {
            state.pending = input.slice(i);
            return;
          }
          handleCsi(match[1], match[2]);
          i += 1 + match[0].length - 1;
          continue;
        }
        if (next === "(" || next === ")") {
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === "\r") {
        col = 0;
        continue;
      }
      if (ch === "\n") {
        lineFeed();
        continue;
      }
      if (ch === "\b") {
        col = Math.max(0, col - 1);
        continue;
      }
      if (ch === "\t") {
        col = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8);
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue;
      put(ch);
    }
  };

  const lines = () =>
    grid.map((line) => line.join("").replace(/\s+$/u, "")).filter((line, index, all) => {
      if (line.length > 0) return true;
      return all.slice(index + 1).some((later) => later.length > 0);
    });

  return {
    write: feed,
    lines,
    text: () => lines().join("\n"),
  };
}

export function parseFrame(raw, options = {}) {
  const screen = createScreen(options.cols ?? 120, options.rows ?? 36);
  screen.write(raw);
  return { text: screen.text(), lines: screen.lines() };
}
