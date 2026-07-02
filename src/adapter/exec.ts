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
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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
      exitCode = code;
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle();
      }, opts.streamGraceMs ?? 5000);
    });

    child.on("close", settle);

    // EPIPE from a fast-exiting child is expected; the outcome is captured by the exit code
    child.stdin.on("error", () => {});
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
