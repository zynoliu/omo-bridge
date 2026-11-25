import { execFileSync } from "node:child_process";

/**
 * The official host keeps provider credentials in its agent directory's `auth.json` and reads no
 * provider environment variable, so a case that needs a real model turn writes that document before
 * starting the daemon. It arrives on stdin: the key never appears in a process argument.
 */
export const MODEL_PROVIDER = "opencode-go";

export function modelKey(): string | undefined {
  const key = process.env.BRIDGE_QA_MODEL_KEY;
  return key === undefined || key.length === 0 ? undefined : key;
}

export function stageProviderCredential(container: string, key: string, provider: string = MODEL_PROVIDER): void {
  execFileSync(
    "docker",
    ["exec", "-i", container, "sh", "-c", "umask 077; mkdir -p /home/bridge/.omo/agent; cat > /home/bridge/.omo/agent/auth.json"],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: JSON.stringify({ [provider]: { type: "api_key", key: key } }),
    },
  );
}

export function credentialStatus(container: string, provider: string = MODEL_PROVIDER): string {
  return execFileSync("docker", ["exec", container, "omo", "auth", "check", "--provider", provider, "--json"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
