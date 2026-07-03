import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../workflow/hash.js";
import type { CoverageRunner } from "./coverage.js";
import { createImportWalker } from "./imports.js";
import { discoverTestFiles } from "./testfiles.js";
import type { EdgeMethod, TestEntry, TestMapFile } from "./types.js";

export interface BuildMapOptions {
  workdir: string;
  /** null = static-only build (no coverage runs). */
  runner: CoverageRunner | null;
  previous: TestMapFile | null;
  log?: (message: string) => void;
}

export function invertedIndex(tests: Record<string, TestEntry>): Record<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const [testFile, entry] of Object.entries(tests)) {
    for (const source of Object.keys(entry.sources)) {
      let set = index.get(source);
      if (set === undefined) {
        set = new Set();
        index.set(source, set);
      }
      set.add(testFile);
    }
  }
  return Object.fromEntries(
    [...index.keys()].sort().map((source) => [source, [...(index.get(source) as Set<string>)].sort()]),
  );
}

export async function buildMap(opts: BuildMapOptions): Promise<TestMapFile> {
  const log = opts.log ?? (() => {});
  const testFiles = await discoverTestFiles(opts.workdir);
  const walker = createImportWalker(opts.workdir);
  const tests: Record<string, TestEntry> = {};
  for (const testFile of testFiles) {
    const content = await readFile(join(opts.workdir, testFile), "utf8");
    const hash = sha256(content);
    const prev = opts.previous?.tests[testFile];
    // Hash-unchanged entries are reused wholesale — including coverage edges
    // from an earlier full build when this build is static-only.
    if (prev !== undefined && prev.hash === hash) {
      tests[testFile] = prev;
      continue;
    }
    const sources: Record<string, EdgeMethod> = {};
    for (const source of walker.sourcesFor(testFile)) sources[source] = "static";
    const entry: TestEntry = { hash, sources };
    if (opts.runner !== null) {
      log(`coverage: ${testFile}`);
      const result = await opts.runner.run(testFile);
      if ("error" in result) {
        entry.coverageError = result.error;
      } else {
        for (const source of result.sources) {
          sources[source] = sources[source] === "static" ? "both" : "coverage";
        }
      }
    }
    tests[testFile] = entry;
  }
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    mode: opts.runner === null ? "static-only" : "full",
    tests,
    sources: invertedIndex(tests),
  };
}
