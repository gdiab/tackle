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
  // A static-only previous map carries no coverage evidence. If this build
  // has a runner, treat that previous map as absent entirely — coarse, but
  // honest — so every entry gets a real coverage run rather than inheriting
  // coverage evidence under a "full" mode that never actually ran coverage.
  // The inverse (a static-only rebuild reusing a full previous map's
  // entries) still reuses below: that keeps richer data than a static-only
  // rebuild could produce on its own.
  const previous = opts.runner !== null && opts.previous?.mode === "static-only" ? null : opts.previous;
  for (const testFile of testFiles) {
    const content = await readFile(join(opts.workdir, testFile), "utf8");
    const hash = sha256(content);
    const prev = previous?.tests[testFile];

    // Static edges are always recomputed: the walk is cheap, and reusing a
    // prior test file's entry wholesale would miss changes in a helper it
    // transitively imports (the test file itself can be hash-unchanged
    // while a file it reaches through an import chain is not).
    const sources: Record<string, EdgeMethod> = {};
    for (const source of walker.sourcesFor(testFile)) sources[source] = "static";
    const entry: TestEntry = { hash, sources };

    // A coverage run that previously failed is retried (not reused forever)
    // whenever a runner is available.
    const retryNeeded = opts.runner !== null && prev?.coverageError !== undefined;
    if (prev !== undefined && prev.hash === hash && !retryNeeded) {
      // Test file unchanged: reuse coverage evidence, merged onto the fresh
      // static set above, without re-running coverage.
      for (const [source, method] of Object.entries(prev.sources)) {
        if (method === "coverage" || method === "both") {
          sources[source] = sources[source] === "static" ? "both" : "coverage";
        }
      }
      if (prev.coverageError !== undefined && opts.runner === null) {
        // A static-only rebuild can't retry a failed coverage run — carry
        // the error forward rather than silently dropping it.
        entry.coverageError = prev.coverageError;
      }
    } else if (opts.runner !== null) {
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
