import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { activeGroupCount, killActiveGroups, runCommand } from "../src/adapter/exec.js";

const nodeEnv = { PATH: process.env.PATH ?? "" };

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true;
    }
  }
  return false;
}

describe("runCommand", () => {
  it("captures exit code, stdout, and per-line callbacks", async () => {
    const lines: string[] = [];
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `console.log("one"); console.log("two");`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
      onLine: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(lines).toEqual(["one", "two"]);
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("pipes stdin to the child", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `process.stdin.pipe(process.stdout);`],
      stdin: "hello from stdin",
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("hello from stdin");
  });

  it("reports nonzero exit codes and stderr", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `console.error("boom"); process.exit(3);`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("does not crash when the child exits before consuming stdin", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", "process.exit(7)"],
      stdin: "x".repeat(1024 * 1024),
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(7);
  });

  it("resolves shortly after exit even when a grandchild holds stdout open", async () => {
    const start = Date.now();
    const result = await runCommand({
      cmd: process.execPath,
      // .unref() lets the intermediate node process exit immediately; the sleep
      // grandchild inherits (and holds open) its stdout pipe, so 'close' never fires.
      args: ["-e", `require("child_process").spawn("sleep", ["30"], { stdio: "inherit" }).unref(); console.log("parent done");`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 20_000,
      streamGraceMs: 1_000,
    });
    expect(result.stdout).toContain("parent done");
    expect(result.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("does not mark timedOut when the child exits before the deadline but streams settle in the grace window", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `require("child_process").spawn("sleep", ["30"], { stdio: "inherit" }).unref(); console.log("done");`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 2_000,
      streamGraceMs: 3_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
  });

  it("kills the child and flags timedOut on timeout", async () => {
    const start = Date.now();
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `setTimeout(() => {}, 60_000);`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("kills the grandchild too when the child times out", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: [
        "-e",
        `const gc = require("child_process").spawn("sleep", ["30"], { stdio: "inherit" }); console.log(gc.pid); setTimeout(() => {}, 60_000);`,
      ],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);

    const grandchildPid = Number(result.stdout.trim());
    expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

    try {
      const deadline = Date.now() + 5_000;
      let dead = false;
      while (Date.now() < deadline) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          dead = true;
          break;
        }
      }
      expect(dead).toBe(true);
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already dead, which is the point of this test
        }
      }
    }
  });

  it("killActiveGroups forwards a signal to a hanging child's whole process group, reaching grandchildren", async () => {
    let childPid = -1;
    let grandchildPid = -1;

    const resultPromise = runCommand({
      cmd: process.execPath,
      args: [
        "-e",
        `console.log("child:" + process.pid); const gc = require("child_process").spawn("sleep", ["30"], { stdio: "inherit" }); console.log("grandchild:" + gc.pid); setTimeout(() => {}, 60_000);`,
      ],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 20_000,
      onLine: (line) => {
        if (line.startsWith("child:")) childPid = Number(line.slice("child:".length));
        if (line.startsWith("grandchild:")) grandchildPid = Number(line.slice("grandchild:".length));
      },
    });

    await waitFor(() => grandchildPid !== -1);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

    killActiveGroups("SIGTERM");

    try {
      const result = await resultPromise;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBeNull();

      expect(await waitForDeath(childPid)).toBe(true);
      expect(await waitForDeath(grandchildPid)).toBe(true);
    } finally {
      for (const pid of [childPid, grandchildPid]) {
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead, which is the point of this test
          }
        }
      }
    }
  });

  it("clears the active-group registry on normal exit, so killActiveGroups is a no-op afterward", async () => {
    expect(activeGroupCount()).toBe(0);

    await runCommand({
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });

    expect(activeGroupCount()).toBe(0);

    // Sentinel: an unrelated long-lived process that exec.ts never tracked.
    // If killActiveGroups had a stale/leaked registry entry, sending a signal
    // here would risk hitting an unrelated pid; assert the sentinel survives.
    const sentinel = spawn("sleep", ["5"], { detached: true });
    try {
      killActiveGroups("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      expect(sentinel.exitCode).toBeNull();
    } finally {
      if (sentinel.pid !== undefined) {
        try {
          process.kill(-sentinel.pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  });

  it("forwards SIGINT to a hanging grandchild when the full tackle process is interrupted", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/exec-sigint-integration.ts", import.meta.url));

    // Run the fixture as a real, separate OS process directly under node
    // (native TypeScript type-stripping, not tsx) so the process actually
    // dies from the raw, unhandled SIGINT rather than tsx's runtime
    // translating it into an explicit process.exit(128+n) call, which would
    // defeat this test's whole point of checking the *conventional signal*
    // exit status.
    const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
      cwd: process.cwd(),
      env: nodeEnv,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let grandchildPid = -1;
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/grandchild:(\d+)/);
      if (match?.[1]) grandchildPid = Number(match[1]);
    });

    try {
      await waitFor(() => grandchildPid !== -1, 10_000);
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });

      process.kill(child.pid!, "SIGINT");

      const { code, signal } = await exited;
      expect(signal).toBe("SIGINT");
      expect(code).toBeNull();

      expect(await waitForDeath(grandchildPid)).toBe(true);
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  });
});
