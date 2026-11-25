/**
 * Test-only extension: drives one tool call through the host's real permission pipeline.
 *
 * It exists to ask the isolated host a single question - "does an extension-invoked tool call go
 * through the same permission gate as a model-invoked one, and does a refused answer actually stop the
 * tool?" - and to record the answer where the case can read it. It is never installed outside the
 * throwaway QA container.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESULT = "/work/ext-result.json";

function record(value: unknown) {
  writeFileSync(RESULT, JSON.stringify(value));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    record({ stage: "started" });
    /* The call waits for the client to be attached: a prompt raised while the session is still
       starting has no eligible presenter, so a probe that fires immediately only measures that. */
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const api = pi as unknown as { executeTool?: (name: string, params: unknown) => Promise<unknown> };
    const context = ctx as unknown as { executeTool?: (name: string, params: unknown) => Promise<unknown> };
    const execute = api.executeTool ?? context.executeTool;
    record({ stage: "resolved", onApi: typeof api.executeTool, onContext: typeof context.executeTool });
    if (execute === undefined) return;
    try {
      const result = await execute.call(api.executeTool === undefined ? context : api, "bash", { command: "echo RAN > /work/bash-ran.txt" });
      record({ stage: "executed", result: result as unknown });
    } catch (error) {
      record({ stage: "threw", error: String(error) });
    }
  });
}
