import { describe, expect, it } from "vitest";
import { runCommand } from "../src/adapter/exec.js";

const nodeEnv = { PATH: process.env.PATH ?? "" };

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
});
