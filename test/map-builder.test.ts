import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMap } from "../src/map/builder.js";
import type { CoverageRunner } from "../src/map/coverage.js";

async function tinyRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tackle-build-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(dir, "test", "a.test.ts"), 'import { a } from "../src/a";\nexport const x = a;\n');
  return dir;
}

function countingRunner(result: { sources: string[] } | { error: string }): CoverageRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (testFileRel) => {
      calls.push(testFileRel);
      return result;
    },
  };
}

describe("buildMap", () => {
  it("merges static and coverage edges with provenance and builds the inverted index", async () => {
    const dir = await tinyRepo();
    const runner = countingRunner({ sources: ["src/a.ts", "src/b.ts"] });
    const map = await buildMap({ workdir: dir, runner, previous: null });
    expect(map.mode).toBe("full");
    expect(map.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "both", // static AND coverage
      "src/b.ts": "coverage", // coverage only — the import graph can't see it
    });
    expect(map.sources).toEqual({
      "src/a.ts": ["test/a.test.ts"],
      "src/b.ts": ["test/a.test.ts"],
    });
  });

  it("reuses hash-unchanged entries without re-running coverage", async () => {
    const dir = await tinyRepo();
    const first = countingRunner({ sources: ["src/a.ts"] });
    const map1 = await buildMap({ workdir: dir, runner: first, previous: null });
    expect(first.calls).toEqual(["test/a.test.ts"]);

    const second = countingRunner({ sources: ["src/a.ts"] });
    const map2 = await buildMap({ workdir: dir, runner: second, previous: map1 });
    expect(second.calls).toEqual([]); // nothing changed => no coverage run
    expect(map2.tests).toEqual(map1.tests);
  });

  it("rebuilds changed test files and drops deleted ones", async () => {
    const dir = await tinyRepo();
    const runner = countingRunner({ sources: ["src/a.ts"] });
    const map1 = await buildMap({ workdir: dir, runner, previous: null });

    await writeFile(join(dir, "test", "a.test.ts"), 'import { b } from "../src/b";\nexport const x = b;\n');
    await writeFile(join(dir, "test", "gone.test.ts"), "export {};\n");
    const map2 = await buildMap({ workdir: dir, runner, previous: map1 });
    expect(map2.tests["test/a.test.ts"]?.sources["src/b.ts"]).toBeDefined();

    await rm(join(dir, "test", "gone.test.ts"));
    const map3 = await buildMap({ workdir: dir, runner, previous: map2 });
    expect(map3.tests["test/gone.test.ts"]).toBeUndefined();
  });

  it("records a coverage error and keeps static edges", async () => {
    const dir = await tinyRepo();
    const map = await buildMap({ workdir: dir, runner: countingRunner({ error: "boom" }), previous: null });
    const entry = map.tests["test/a.test.ts"];
    expect(entry?.coverageError).toBe("boom");
    expect(entry?.sources).toEqual({ "src/a.ts": "static" });
  });

  it("builds static-only when the runner is null", async () => {
    const dir = await tinyRepo();
    const map = await buildMap({ workdir: dir, runner: null, previous: null });
    expect(map.mode).toBe("static-only");
    expect(map.tests["test/a.test.ts"]?.sources).toEqual({ "src/a.ts": "static" });
  });

  it("re-runs coverage for hash-unchanged entries when the previous map was static-only", async () => {
    const dir = await tinyRepo();
    const staticOnly = await buildMap({ workdir: dir, runner: null, previous: null });
    expect(staticOnly.mode).toBe("static-only");
    expect(staticOnly.tests["test/a.test.ts"]?.sources).toEqual({ "src/a.ts": "static" });

    const runner = countingRunner({ sources: ["src/a.ts", "src/b.ts"] });
    const map = await buildMap({ workdir: dir, runner, previous: staticOnly });
    // Hash is unchanged, but a static-only previous map has no coverage
    // evidence to inherit — the runner must actually run.
    expect(runner.calls).toEqual(["test/a.test.ts"]);
    expect(map.mode).toBe("full");
    expect(map.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "both",
      "src/b.ts": "coverage",
    });
  });

  it("retries a previously failed coverage run instead of reusing the error forever", async () => {
    const dir = await tinyRepo();
    const failing = countingRunner({ error: "boom" });
    const map1 = await buildMap({ workdir: dir, runner: failing, previous: null });
    expect(map1.tests["test/a.test.ts"]?.coverageError).toBe("boom");

    const succeeding = countingRunner({ sources: ["src/a.ts"] });
    const map2 = await buildMap({ workdir: dir, runner: succeeding, previous: map1 });
    expect(succeeding.calls).toEqual(["test/a.test.ts"]); // retried, not reused
    expect(map2.tests["test/a.test.ts"]?.coverageError).toBeUndefined();
    expect(map2.tests["test/a.test.ts"]?.sources).toEqual({ "src/a.ts": "both" });
  });

  it("recomputes static edges when a transitively imported helper gains an import", async () => {
    const dir = await tinyRepo();
    await writeFile(join(dir, "test", "helper.ts"), "export const h = 1;\n");
    await writeFile(
      join(dir, "test", "a.test.ts"),
      'import { a } from "../src/a";\nimport { h } from "./helper";\nexport const x = a + h;\n',
    );
    const map1 = await buildMap({ workdir: dir, runner: null, previous: null });
    expect(map1.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "static",
      "test/helper.ts": "static",
    });

    // helper.ts gains an import of src/b.ts; a.test.ts itself is unchanged.
    await writeFile(join(dir, "test", "helper.ts"), 'import { b } from "../src/b";\nexport const h = b;\n');
    const map2 = await buildMap({ workdir: dir, runner: null, previous: map1 });
    expect(map2.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "static",
      "test/helper.ts": "static",
      "src/b.ts": "static",
    });
  });

  it("recomputes static edges when a transitively imported helper loses an import", async () => {
    const dir = await tinyRepo();
    await writeFile(join(dir, "test", "helper.ts"), 'import { b } from "../src/b";\nexport const h = b;\n');
    await writeFile(
      join(dir, "test", "a.test.ts"),
      'import { a } from "../src/a";\nimport { h } from "./helper";\nexport const x = a + h;\n',
    );
    const map1 = await buildMap({ workdir: dir, runner: null, previous: null });
    expect(map1.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "static",
      "test/helper.ts": "static",
      "src/b.ts": "static",
    });

    // helper.ts loses its import of src/b.ts; a.test.ts itself is unchanged.
    await writeFile(join(dir, "test", "helper.ts"), "export const h = 1;\n");
    const map2 = await buildMap({ workdir: dir, runner: null, previous: map1 });
    expect(map2.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "static",
      "test/helper.ts": "static",
    });
  });

  it("reuses coverage evidence across a static recompute without invoking the runner", async () => {
    const dir = await tinyRepo();
    const first = countingRunner({ sources: ["src/a.ts", "src/b.ts"] });
    const map1 = await buildMap({ workdir: dir, runner: first, previous: null });
    expect(map1.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "both", // static AND coverage
      "src/b.ts": "coverage", // coverage only
    });

    const second = countingRunner({ sources: ["src/a.ts", "src/b.ts"] });
    const map2 = await buildMap({ workdir: dir, runner: second, previous: map1 });
    expect(second.calls).toEqual([]); // hash unchanged => coverage evidence reused, runner not called
    expect(map2.tests["test/a.test.ts"]?.sources).toEqual({
      "src/a.ts": "both",
      "src/b.ts": "coverage",
    });
  });

  it("carries a coverageError forward on a static-only rebuild when the hash is unchanged", async () => {
    const dir = await tinyRepo();
    const map1 = await buildMap({ workdir: dir, runner: countingRunner({ error: "boom" }), previous: null });
    expect(map1.tests["test/a.test.ts"]?.coverageError).toBe("boom");

    const map2 = await buildMap({ workdir: dir, runner: null, previous: map1 });
    expect(map2.mode).toBe("static-only");
    expect(map2.tests["test/a.test.ts"]?.coverageError).toBe("boom");
    expect(map2.tests["test/a.test.ts"]?.sources).toEqual({ "src/a.ts": "static" });
  });
});
