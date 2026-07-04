import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitestCoverageRunner, findVitestBin } from "../src/map/coverage.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cov-repo");

describe("findVitestBin", () => {
  it("finds the bin by walking up from a nested dir", () => {
    expect(findVitestBin(fixture)).toMatch(/node_modules\/\.bin\/vitest$/);
  });

  it("returns null outside any node_modules tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cov-none-"));
    expect(findVitestBin(dir)).toBeNull();
  });
});

describe("createVitestCoverageRunner", () => {
  it("returns null when vitest is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cov-none-"));
    expect(createVitestCoverageRunner(dir)).toBeNull();
  });

  it("attributes executed source files to the test file", { timeout: 120_000 }, async () => {
    const runner = createVitestCoverageRunner(fixture);
    expect(runner).not.toBeNull();
    const result = await runner!.run("add.test.ts");
    expect(result).toEqual({ sources: ["src/add.ts"] }); // unused.ts never loads
  });

  it("reports an error when no coverage output is produced", { timeout: 120_000 }, async () => {
    const runner = createVitestCoverageRunner(fixture);
    const result = await runner!.run("missing.test.ts");
    expect(result).toHaveProperty("error");
  });

  it("reports an error for a failing run instead of consuming its coverage", { timeout: 120_000 }, async () => {
    const runner = createVitestCoverageRunner(fixture);
    const result = await runner!.run("fail.test.ts");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/exit \d+/);
  });
});
