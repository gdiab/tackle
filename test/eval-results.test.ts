import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedRun } from "../src/evals/results.js";
import { appendRun, readResult, RUN_WINDOW, writeResult } from "../src/evals/results.js";
import { tempWorkdir } from "./helpers/workflow.js";

function run(at: string, pass = true): RecordedRun {
  return {
    at,
    adapterVersion: "codex-cli 0.0.0",
    envelope: {
      status: "completed",
      summary: "s",
      authorship: { adapter: "codex", model: null, effort: "low" },
      usage: {
        tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
        billingType: "subscription",
      },
    },
    workdirDiff: "",
    grade: { pass, expectations: [] },
  };
}

describe("readResult / writeResult", () => {
  it("returns null when the result file does not exist", async () => {
    expect(await readResult(await tempWorkdir(), "create-file")).toBeNull();
  });

  it("round-trips a result file with a trailing newline", async () => {
    const workdir = await tempWorkdir();
    const result = { fixture: "create-file", fingerprint: "sha256:abc", runs: [run("2026-07-05T00:00:00.000Z")] };
    await writeResult(workdir, result);
    expect(await readResult(workdir, "create-file")).toEqual(result);
    const raw = await readFile(join(workdir, "evals", "results", "create-file.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("throws with guidance on invalid JSON and on a wrong shape", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "evals", "results"), { recursive: true });
    await writeFile(join(workdir, "evals", "results", "broken.json"), "{nope");
    await expect(readResult(workdir, "broken")).rejects.toThrow(/not valid JSON/);
    await writeFile(join(workdir, "evals", "results", "odd.json"), JSON.stringify({ fixture: "odd" }) + "\n");
    await expect(readResult(workdir, "odd")).rejects.toThrow(/missing/);
  });
});

describe("appendRun", () => {
  it("starts fresh history when there is no existing result", () => {
    const result = appendRun(null, "f", "sha256:a", run("t1"));
    expect(result).toEqual({ fixture: "f", fingerprint: "sha256:a", runs: [run("t1")] });
  });

  it("prepends newest-first and caps the window at RUN_WINDOW", () => {
    let result = appendRun(null, "f", "sha256:a", run("t0"));
    for (let i = 1; i <= RUN_WINDOW + 2; i++) result = appendRun(result, "f", "sha256:a", run(`t${i}`));
    expect(result.runs).toHaveLength(RUN_WINDOW);
    expect(result.runs[0]?.at).toBe(`t${RUN_WINDOW + 2}`);
    expect(result.runs[RUN_WINDOW - 1]?.at).toBe("t3");
  });

  it("resets history on a fingerprint change", () => {
    const existing = appendRun(null, "f", "sha256:a", run("t1", false));
    const reset = appendRun(existing, "f", "sha256:b", run("t2"));
    expect(reset).toEqual({ fixture: "f", fingerprint: "sha256:b", runs: [run("t2")] });
  });
});
