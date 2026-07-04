import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runCommand } from "../adapter/exec.js";
import { isTestFile } from "./testfiles.js";

export interface CoverageRunner {
  /** Repo-relative source files the test file executed, or an error to record on the entry. */
  run(testFileRel: string): Promise<{ sources: string[] } | { error: string }>;
}

/** The target repo's vitest, found by walking up — tackle does not bundle a test runner. */
export function findVitestBin(workdir: string): string | null {
  let dir = resolve(workdir);
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", "vitest");
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface IstanbulFileCoverage {
  s: Record<string, number>;
}

export function createVitestCoverageRunner(
  workdir: string,
  opts: { timeoutMs?: number } = {},
): CoverageRunner | null {
  const bin = findVitestBin(workdir);
  if (bin === null) return null;
  const root = resolve(workdir);
  return {
    async run(testFileRel) {
      const reportsDir = await mkdtemp(join(tmpdir(), "tackle-cov-"));
      try {
        // `bin` is the shell-script shim under node_modules/.bin — spawning
        // it directly assumes POSIX; Windows would need `.cmd` resolution.
        const result = await runCommand({
          cmd: bin,
          args: [
            "run",
            testFileRel,
            "--coverage.enabled",
            "--coverage.reporter=json",
            "--coverage.reportOnFailure",
            `--coverage.reportsDirectory=${reportsDir}`,
          ],
          cwd: root,
          env: process.env as Record<string, string>,
          timeoutMs: opts.timeoutMs ?? 120_000,
        });
        const noCoverageError = (): { error: string } => {
          const tail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
          return { error: `no coverage output (exit ${result.exitCode}): ${tail}` };
        };
        if (result.timedOut) return { error: "coverage run timed out" };
        if (result.exitCode !== 0) {
          // `--coverage.reportOnFailure` can still leave a coverage-final.json behind
          // for a failing (or killed) run. That file reflects whatever partially
          // executed before the failure, not a trustworthy record of what the test
          // exercises — a red test must not get treated as clean evidence. It falls
          // back to static-only edges (via coverageError on the entry) until it
          // passes, and the builder's coverageError-retry re-runs it on the next build.
          const tail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
          return { error: `coverage run failed (exit ${result.exitCode}): ${tail}` };
        }
        const finalPath = join(reportsDir, "coverage-final.json");
        if (!existsSync(finalPath)) {
          return noCoverageError();
        }
        let parsed: Record<string, IstanbulFileCoverage>;
        try {
          parsed = JSON.parse(await readFile(finalPath, "utf8"));
        } catch {
          return { error: "coverage output was not valid JSON" };
        }
        // v8's --coverage.reportOnFailure still writes coverage-final.json when no
        // test file matched at all; an empty map means nothing ran, not "ran but
        // touched no source" (a real run always instruments its test file's
        // dependency graph).
        if (Object.keys(parsed).length === 0) return noCoverageError();
        const sources: string[] = [];
        for (const [absPath, cov] of Object.entries(parsed)) {
          if (!Object.values(cov.s).some((count) => count > 0)) continue;
          const rel = relative(root, absPath).split(sep).join("/");
          if (rel.startsWith("..") || isTestFile(rel)) continue;
          sources.push(rel);
        }
        return { sources: sources.sort() };
      } finally {
        await rm(reportsDir, { recursive: true, force: true });
      }
    },
  };
}
