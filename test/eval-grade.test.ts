import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffPaths, gradeFixture } from "../src/evals/grade.js";
import type { RecordedEnvelope } from "../src/evals/grade.js";
import type { Expectation, FixtureManifest } from "../src/evals/manifest.js";
import { tempWorkdir } from "./helpers/workflow.js";

function envelope(overrides: Partial<RecordedEnvelope> = {}): RecordedEnvelope {
  return {
    status: "completed",
    summary: "did it",
    authorship: { adapter: "codex", model: null, effort: "low" },
    usage: {
      tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
      billingType: "subscription",
    },
    ...overrides,
  };
}

function manifestWith(expectations: Expectation[]): FixtureManifest {
  return { name: "f", description: "d", prompt: "p", effort: "low", timeoutSeconds: 60, expectations };
}

async function gradeOne(expectation: Expectation, opts: { envelope?: RecordedEnvelope; workdir?: string; workdirDiff?: string } = {}) {
  const workdir = opts.workdir ?? (await tempWorkdir());
  const grade = await gradeFixture({
    manifest: manifestWith([expectation]),
    envelope: opts.envelope ?? envelope(),
    workdir,
    workdirDiff: opts.workdirDiff ?? "",
  });
  const first = grade.expectations[0];
  if (first === undefined) throw new Error("no expectation graded");
  return { grade, first };
}

describe("envelope graders", () => {
  it("status passes on match and fails with a message on mismatch", async () => {
    expect((await gradeOne({ kind: "status", equals: "completed" })).grade.pass).toBe(true);
    const { grade, first } = await gradeOne({ kind: "status", equals: "completed" }, { envelope: envelope({ status: "timeout" }) });
    expect(grade.pass).toBe(false);
    expect(first.message).toContain('"timeout"');
  });

  it("billing compares the envelope billingType", async () => {
    expect((await gradeOne({ kind: "billing", equals: "subscription" })).grade.pass).toBe(true);
    const { grade } = await gradeOne(
      { kind: "billing", equals: "subscription" },
      { envelope: envelope({ usage: { ...envelope().usage, billingType: "metered" } }) },
    );
    expect(grade.pass).toBe(false);
  });
});

describe("workdir graders", () => {
  it("fileExists and fileContains (substring and exact)", async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, "hello.txt"), "well hello there\n");
    expect((await gradeOne({ kind: "fileExists", path: "hello.txt" }, { workdir })).grade.pass).toBe(true);
    expect((await gradeOne({ kind: "fileExists", path: "nope.txt" }, { workdir })).grade.pass).toBe(false);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "hello" }, { workdir })).grade.pass).toBe(true);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "goodbye" }, { workdir })).grade.pass).toBe(false);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "hello", exact: true }, { workdir })).grade.pass).toBe(false);
    expect(
      (await gradeOne({ kind: "fileContains", path: "hello.txt", text: "well hello there\n", exact: true }, { workdir })).grade.pass,
    ).toBe(true);
    expect((await gradeOne({ kind: "fileContains", path: "nope.txt", text: "x" }, { workdir })).grade.pass).toBe(false);
  });

  it("commandSucceeds runs in the workdir and grades on exit code", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "marker-dir"));
    expect(
      (await gradeOne({ kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('marker-dir')\"" }, { workdir })).grade.pass,
    ).toBe(true);
    const { grade, first } = await gradeOne({ kind: "commandSucceeds", command: "node -e \"process.exit(3)\"" }, { workdir });
    expect(grade.pass).toBe(false);
    expect(first.message.length).toBeGreaterThan(0);
  });
});

describe("diffTouchesOnly", () => {
  const diff = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 000..111 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/rogue.txt b/rogue.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/rogue.txt",
    "@@ -0,0 +1 @@",
    "+surprise",
    "",
  ].join("\n");

  it("extracts touched paths, ignoring /dev/null", () => {
    expect(diffPaths(diff)).toEqual(["rogue.txt", "src/keep.ts"]);
  });

  it("passes when all touched paths match a glob, fails and names the stray otherwise", async () => {
    expect((await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**", "rogue.txt"] }, { workdirDiff: diff })).grade.pass).toBe(true);
    const { grade, first } = await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**"] }, { workdirDiff: diff });
    expect(grade.pass).toBe(false);
    expect(first.message).toContain("rogue.txt");
  });

  it("passes on an empty diff", async () => {
    expect((await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**"] }, { workdirDiff: "" })).grade.pass).toBe(true);
  });
});

describe("exhaustiveness", () => {
  it("throws on an unknown kind smuggled past validation", async () => {
    const rogue = { kind: "vibes" } as unknown as Expectation;
    await expect(
      gradeFixture({ manifest: manifestWith([rogue]), envelope: envelope(), workdir: await tempWorkdir(), workdirDiff: "" }),
    ).rejects.toThrow(/unknown expectation kind/);
  });

  it("aggregate pass requires every expectation to pass", async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, "hello.txt"), "hello\n");
    const grade = await gradeFixture({
      manifest: manifestWith([
        { kind: "fileExists", path: "hello.txt" },
        { kind: "status", equals: "refused" },
      ]),
      envelope: envelope(),
      workdir,
      workdirDiff: "",
    });
    expect(grade.pass).toBe(false);
    expect(grade.expectations.map((e) => e.pass)).toEqual([true, false]);
  });
});
