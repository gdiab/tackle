import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
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
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ exitCode, timedOut, stdout, stderr });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
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
