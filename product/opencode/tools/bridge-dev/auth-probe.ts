/* Scratch probe (deleted after use): does the bridge's own handshake authenticate against the isolated host? */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openSocketGateway } from "./socket-gateway.ts";
import { openBridgeTransport } from "../../packages/cli/src/bridge-run.ts";

const root = mkdtempSync(path.join(tmpdir(), "bridge-auth-"));
const gateway = await openSocketGateway({
  socketPath: path.join(root, "bridge.sock"),
  container: "bridge-host-run",
  containerSocket: "/home/bridge/.omo/agent/rpc/rpc.sock",
});
try {
  const transport = await openBridgeTransport({
    socket: gateway.socketPath,
    keyRecord: "/tmp/bridge-run-owned/keys/9c00c14b-1047-4f69-8286-97cf59601224",
    cwd: "/work",
    mini: false,
    handshakeTimeoutMs: 15_000,
  });
  console.log("STATE:" + transport.report.state + ":" + transport.report.code);
  const info = await transport.request("get_protocol_info", {});
  console.log("PROTOCOL:" + JSON.stringify(info).slice(0, 160));
  transport.close();
} finally {
  await gateway.close();
  rmSync(root, { recursive: true, force: true });
}
