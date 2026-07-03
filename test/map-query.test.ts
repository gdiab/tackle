import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeMap, testsFor } from "../src/map/query.js";
import { writeTestMap } from "../src/map/store.js";
import type { TestMapFile } from "../src/map/types.js";

function sampleMap(): TestMapFile {
  return {
    version: 1,
    builtAt: "2026-07-03T00:00:00.000Z",
    mode: "full",
    tests: {
      "test/a.test.ts": { hash: "h1", sources: { "src/a.ts": "both" } },
      "test/b.test.ts": { hash: "h2", sources: { "src/a.ts": "static" }, coverageError: "boom" },
    },
    sources: { "src/a.ts": ["test/a.test.ts", "test/b.test.ts"] },
  };
}

async function withMap(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tackle-query-"));
  await writeTestMap(dir, sampleMap());
  return dir;
}

describe("testsFor", () => {
  it("reports no-map when the map is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-query-"));
    expect(await testsFor(dir, "src/a.ts")).toEqual({ kind: "no-map" });
  });

  it("returns mapped tests with per-edge provenance", async () => {
    expect(await testsFor(await withMap(), "src/a.ts")).toEqual({
      kind: "mapped",
      tests: [
        { test: "test/a.test.ts", method: "both" },
        { test: "test/b.test.ts", method: "static" },
      ],
    });
  });

  it("normalizes relative and absolute inputs to repo-relative paths", async () => {
    const dir = await withMap();
    expect((await testsFor(dir, "./src/a.ts")).kind).toBe("mapped");
    expect((await testsFor(dir, join(dir, "src", "a.ts"))).kind).toBe("mapped");
  });

  it("reports unmapped for a source no test exercises", async () => {
    expect(await testsFor(await withMap(), "src/new.ts")).toEqual({ kind: "unmapped" });
  });
});

describe("describeMap", () => {
  it("summarizes counts, mode, and coverage failures", () => {
    expect(describeMap(sampleMap())).toEqual({
      builtAt: "2026-07-03T00:00:00.000Z",
      mode: "full",
      testCount: 2,
      sourceCount: 1,
      coverageFailures: ["test/b.test.ts"],
    });
  });
});
