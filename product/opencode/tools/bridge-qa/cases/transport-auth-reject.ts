import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { AuthGate, TransportError, challengeResponse, loadAuthMaterial } from "../../../packages/bridge-core/src/transport.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const secretPath = path.join(context.out, "auth-material.bin");
  fs.writeFileSync(secretPath, Buffer.alloc(32, 5), { mode: 0o600 });
  const material = loadAuthMaterial(() => fs.readFileSync(secretPath));
  const gate = new AuthGate(material);
  const challenge = gate.begin();

  let rejection = "none";
  try {
    gate.verify(challenge, challengeResponse(Buffer.alloc(32, 6), challenge));
  } catch (error) {
    rejection = error instanceof TransportError ? error.code : "untyped";
  }

  const checks: Check[] = [
    { name: "wrong-response-rejected", expected: "AUTH_REJECTED", observed: rejection, pass: rejection === "AUTH_REJECTED" },
    {
      name: "never-connected",
      expected: "state closed, not connected",
      observed: gate.currentState,
      pass: gate.currentState !== "connected",
    },
  ];

  fs.unlinkSync(secretPath);
  return {
    checks: checks,
    cleanup: { ok: !fs.existsSync(secretPath), detail: ["temporary auth material removed, value never printed"] },
  };
}
