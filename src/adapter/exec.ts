import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

// Process groups (pgid === child pid, thanks to detached: true) for spawns
// currently in flight. Entries are added right after a successful spawn and
// removed at every settle/reject choke point below, so the set can never
// leak a pid past the lifetime of its runCommand() call.
const activeGroups = new Set<number>();
let signalForwardingInstalled = false;

/**
 * Send `signal` to every tracked child's process group. Called by the
 * lazily-installed SIGINT/SIGTERM handlers below, and exported so tests can
 * exercise the forwarding behavior directly without signaling the test
 * runner's own process.
 */
export function killActiveGroups(signal: NodeJS.Signals): void {
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Group already gone; nothing to forward to.
    }
  }
}

/** Number of process groups currently tracked. Exported for test assertions. */
export function activeGroupCount(): number {
  return activeGroups.size;
}

// Installed lazily (on first spawn) rather than at module load so importing
// exec.ts never has the side effect of touching process-global signal
// listeners.
function installSignalForwarding(): void {
  if (signalForwardingInstalled) return;
  signalForwardingInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      killActiveGroups(sig);
      // Restore default disposition and re-raise so the process still exits
      // with the conventional signal status. Without this, installing a
      // listener would swallow the signal and keep tackle alive.
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

export async function runCommand(opts: {
  cmd: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  streamGraceMs?: number;
  onLine?: (line: string) => void;
}): Promise<ExecResult> {
  installSignalForwarding();
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Make the child the leader of its own process group (pgid === pid) so a
      // timeout can kill the whole tree, not just the direct child. We always
      // await this child, so it is never unref'd.
      detached: true,
    });

    if (child.pid !== undefined) {
      activeGroups.add(child.pid);
    }
    const untrackGroup = () => {
      if (child.pid !== undefined) activeGroups.delete(child.pid);
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the entire process group so grandchildren (e.g. a vitest worker
      // spawned by the child) die too, instead of surviving and holding
      // stdio/files open. Falls back to killing just the child if there is no
      // pid (spawn failure) or the group is already gone (ESRCH) / unsupported
      // (non-POSIX platforms).
      if (child.pid === undefined) {
        child.kill("SIGKILL");
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts.onLine) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", opts.onLine);
    }

    let exitCode: number | null = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = () => {
      if (settled) return;
      settled = true;
      untrackGroup();
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ exitCode, timedOut, stdout, stderr });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      untrackGroup();
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });

    // 'close' waits for stdio EOF; a grandchild inheriting stdout can hold the
    // pipe open indefinitely, so also resolve after a grace window post-'exit'.
    child.on("exit", (code) => {
      // The hard timeout governs the child's lifetime, which has just ended;
      // clear it so it cannot fire later (e.g. during the grace window below)
      // and retroactively mark an already-finished, on-time turn as timed out.
      clearTimeout(timer);
      exitCode = code;
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle();
      }, opts.streamGraceMs ?? 5000);
    });

    child.on("close", settle);

    // EPIPE from a fast-exiting child is expected; the outcome is captured by the
    // exit code. Any other stdin error is unexpected and rejects the turn (the
    // settled guard keeps this from double-settling against a later exit/close).
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      if (settled) return;
      settled = true;
      untrackGroup();
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
