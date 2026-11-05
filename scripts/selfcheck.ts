const PINNED_SENPI = "2026.11.4-2";

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  dependencies?: Record<string, string>;
};
const actual = pkg.dependencies?.["@code-yeongyu/senpi"];

if (actual !== PINNED_SENPI) {
  console.error(
    `selfcheck: @code-yeongyu/senpi must be pinned to exactly "${PINNED_SENPI}" (no caret/range), found ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

console.log(`selfcheck: ok (@code-yeongyu/senpi pinned to ${PINNED_SENPI})`);
