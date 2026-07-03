import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTestFiles, isTestFile } from "../src/map/testfiles.js";

async function repoWith(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tackle-disc-"));
  for (const rel of files) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), "export {};\n");
  }
  return dir;
}

describe("isTestFile", () => {
  it("matches .test/.spec suffixes across js/ts variants and __tests__ dirs", () => {
    expect(isTestFile("test/a.test.ts")).toBe(true);
    expect(isTestFile("src/b.spec.tsx")).toBe(true);
    expect(isTestFile("src/c.test.mjs")).toBe(true);
    expect(isTestFile("src/__tests__/d.ts")).toBe(true);
    expect(isTestFile("src/main.ts")).toBe(false);
    expect(isTestFile("test/helper.ts")).toBe(false);
    expect(isTestFile("src/testable.ts")).toBe(false);
  });
});

describe("discoverTestFiles", () => {
  it("finds test files recursively, skipping node_modules/dist/hidden dirs", async () => {
    const dir = await repoWith([
      "test/a.test.ts",
      "src/deep/b.spec.ts",
      "src/__tests__/c.ts",
      "src/main.ts",
      "node_modules/pkg/x.test.ts",
      "dist/y.test.ts",
      ".hidden/z.test.ts",
    ]);
    expect(await discoverTestFiles(dir)).toEqual([
      "src/__tests__/c.ts",
      "src/deep/b.spec.ts",
      "test/a.test.ts",
    ]);
  });

  it("returns an empty list for a repo with no tests", async () => {
    expect(await discoverTestFiles(await repoWith(["src/main.ts"]))).toEqual([]);
  });
});
