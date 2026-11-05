import { SenpiTransport } from "../src/senpi/transport";
import { mapSenpiError } from "../src/senpi/errors";

const transport = new SenpiTransport();

try {
  await transport.connect();
  const opened = await transport.openSession({
    cwd: process.env.OMO_BRIDGE_PROBE_CWD ?? process.cwd(),
    retainOnDisconnect: false,
  });
  console.log(`CONNECTED ${opened.sessionId} caps=${transport.clientCapabilities.join(",")}`);
  await transport.dispose();
  process.exit(0);
} catch (error) {
  const mapped = mapSenpiError(error);
  console.log(`ERROR ${mapped.code}`);
  await transport.dispose().catch(() => undefined);
  process.exit(1);
}
