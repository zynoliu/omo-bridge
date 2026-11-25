import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { BridgeClient } from "../../../packages/bridge-core/src/client.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const data = new BridgeData();
  const sessions = new SessionRegistry();
  const client = new BridgeClient({ data, sessions, dialogs: new DialogRegistry(), interaction: new InteractionController() });

  client.sessionCreate("p_live", "Live session");
  const frames = await pump(path.join(context.out, "live.sock"), [
    { kind: "session.updated", sessionId: "p_live", title: "Host title" },
    { kind: "partial", sequence: 0, sessionId: "p_live", text: "streamed" },
    { kind: "message_end", sequence: 1, sessionId: "p_live", text: "streamed" },
  ]);
  for (const frame of frames) data.applyEvent(JSON.parse(frame) as never);
  const view = data.view();

  const checks: Check[] = [
    {
      name: "request-and-event-share-one-view",
      expected: "one session titled Host title",
      observed: view.sessions.length + " session(s), title " + String(view.sessions[0]?.title),
      pass: view.sessions.length === 1 && view.sessions[0]?.title === "Host title",
    },
    {
      name: "streamed-message-in-the-same-view",
      expected: "streamed, status complete",
      observed: JSON.stringify(view.message.text) + "/" + view.message.status,
      pass: view.message.text === "streamed" && view.message.status === "complete",
    },
    {
      name: "client-list-matches-store",
      expected: "1 session",
      observed: String(client.sessionList().length),
      pass: client.sessionList().length === 1,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
