import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createImportWalker } from "../src/map/imports.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "map-repo");

describe("createImportWalker", () => {
  it("resolves direct, transitive, and tsconfig-path-aliased imports; skips externals", () => {
    const walker = createImportWalker(fixture);
    // util.test.ts -> ../src/util (direct), ./helper (in-repo non-test => a source),
    // helper -> @lib/math (transitive through the alias). "vitest" is external: skipped.
    expect(walker.sourcesFor("test/util.test.ts")).toEqual([
      "src/lib/math.ts",
      "src/util.ts",
      "test/helper.ts",
    ]);
  });

  it("resolves a path alias directly from a .spec file", () => {
    const walker = createImportWalker(fixture);
    expect(walker.sourcesFor("test/math.spec.ts")).toEqual(["src/lib/math.ts"]);
  });

  it("falls back to bundler resolution when the repo has no tsconfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-imp-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "a.test.ts"), 'import { a } from "./src/a";\nexport const x = a;\n');
    expect(createImportWalker(dir).sourcesFor("a.test.ts")).toEqual(["src/a.ts"]);
  });

  it("returns no sources for an unreadable test file", () => {
    expect(createImportWalker(fixture).sourcesFor("test/missing.test.ts")).toEqual([]);
  });
});
