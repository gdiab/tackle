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
});
