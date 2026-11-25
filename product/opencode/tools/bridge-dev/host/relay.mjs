#!/usr/bin/env node
/**
 * Byte-transparent relay used inside the isolated host container.
 *
 * It carries nothing but bytes: stdin is copied to a Unix socket and the socket's bytes back to
 * stdout, so the caller's protocol (including any handshake) is untranslated and unwatched. No frame
 * is parsed, logged or stored here — a relay that understood the protocol would be a second place to
 * keep honest about credentials.
 *
 * Usage: node relay.mjs <socket-path>
 */
import net from "node:net";

const target = process.argv[2];
if (!target) {
  process.stderr.write("relay: a socket path is required\n");
  process.exit(2);
}

const socket = net.connect(target);
socket.on("error", (error) => {
  process.stderr.write("relay: " + error.message + "\n");
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on("end", () => socket.end());
