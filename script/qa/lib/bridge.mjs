import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASIC_USER = "opencode";

function auth(password) {
  return `Basic ${Buffer.from(`${BASIC_USER}:${password}`, "utf8").toString("base64")}`;
}

export async function waitForHttp(url, headers, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.status === 200) return await response.json();
    } catch {
      // The bridge is still binding its port.
    }
    await Bun.sleep(250);
  }
  throw new Error(`bridge did not answer ${url} within ${timeoutMs}ms`);
}

export async function startBridge(options = {}) {
  const repo = options.repo ?? process.cwd();
  const bunExe = options.bunExe ?? process.execPath;
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "qa-bridge-"));
  const port = options.port ?? 4500 + Math.floor(Math.random() * 400);
  const password = options.password ?? `qa_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const evidenceDir = options.evidenceDir ?? stateDir;
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = options.logPath ?? join(evidenceDir, "bridge.log");
  writeFileSync(logPath, "");

  const child = Bun.spawn([bunExe, "run", "bin/omo-bridge", "start"], {
    cwd: repo,
    env: {
      ...process.env,
      OMO_BRIDGE_STATE_DIR: stateDir,
      OMO_BRIDGE_PASSWORD: password,
      OMO_BRIDGE_PORT: String(port),
      ...(options.agentDir === undefined ? {} : { OMO_BRIDGE_AGENT_DIR: options.agentDir }),
    },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const pipeLog = async (stream) => {
    for await (const chunk of stream) {
      appendFileSync(logPath, new TextDecoder().decode(chunk));
    }
  };
  void pipeLog(child.stdout);
  void pipeLog(child.stderr);

  const headers = { authorization: auth(password) };
  const url = `http://127.0.0.1:${port}`;
  let info;
  try {
    info = await waitForHttp(`${url}/api/info`, headers, options.timeoutMs ?? 90_000);
  } catch (error) {
    child.kill();
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    Bun.spawn([bunExe, "run", "bin/omo-bridge", "stop"], {
      cwd: repo,
      env: { ...process.env, OMO_BRIDGE_STATE_DIR: stateDir },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (!(await isListening(port))) break;
      await Bun.sleep(200);
    }
    if (await isListening(port)) child.kill("SIGKILL");
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await killHostsFor(stateDir);
  };

  return { url, port, password, stateDir, logPath, info, headers, stop };
}

async function isListening(port) {
  try {
    const probe = Bun.spawn(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(probe.stdout).text();
    await probe.exited;
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function killHostsFor(stateDir) {
  try {
    const found = Bun.spawn(["pgrep", "-f", stateDir], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(found.stdout).text();
    await found.exited;
    for (const line of output.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  } catch {
    // pgrep is best effort.
  }
}

export async function isBridgeListening(port) {
  return isListening(port);
}

export async function createSession({ url, headers, directory, title, id }) {
  const sessionID = id ?? `ses_qa_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ id: sessionID, title: title ?? "qa", location: { directory } }),
  });
  if (!response.ok) throw new Error(`session create failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  return { id: body?.data?.id ?? sessionID };
}
