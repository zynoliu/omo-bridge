/**
 * Read-only git access: argv (no shell), a 5s deadline, and null instead of a throw.
 * Bun.spawn rather than Bun.$ because ShellPromise exposes no timeout or abort hook.
 */

export const GIT_TIMEOUT_MS = 5_000;

export async function gitRead(directory: string, args: readonly string[]): Promise<string | null> {
  try {
    const subprocess = Bun.spawn({
      cmd: ["git", "-C", directory, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        // GIT_OPTIONAL_LOCKS keeps a read from refreshing and rewriting the index.
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    const [stdout, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), subprocess.exited]);
    if (exitCode !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}
