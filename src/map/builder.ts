import { existsSync } from "node:fs";
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
    const staticSources = walker.sourcesFor(testFile); // sorted
    const sources: Record<string, EdgeMethod> = {};
    for (const source of staticSources) sources[source] = "static";
    const entry: TestEntry = { hash, sources };

    // A coverage run that previously failed is retried (not reused forever)
    // whenever a runner is available.
    const retryNeeded = opts.runner !== null && prev?.coverageError !== undefined;
    // Coverage evidence is only trustworthy if the dependency graph it was
    // observed against hasn't moved: a helper losing an import can make the
    // fresh static walk correctly drop a source, but naively merging prior
    // coverage would re-add it as a ghost edge. Compare the previous static
    // set (sources whose method was "static" or "both") to the fresh one.
    const prevStaticSources = prev
      ? Object.entries(prev.sources)
          .filter(([, method]) => method === "static" || method === "both")
          .map(([source]) => source)
          .sort()
      : undefined;
    const graphUnchanged =
      prevStaticSources !== undefined &&
      prevStaticSources.length === staticSources.length &&
      prevStaticSources.every((source, i) => source === staticSources[i]);
    if (prev !== undefined && prev.hash === hash && !retryNeeded && graphUnchanged) {
      // Test file unchanged and its static dependency set unchanged: reuse
      // coverage evidence, merged onto the fresh static set above, without
      // re-running coverage. A coverage-only source whose file has since
      // been deleted is invisible to the static-set comparison above (it
      // was never statically reachable), so it's filtered here instead.
      for (const [source, method] of Object.entries(prev.sources)) {
        if (method === "coverage" || method === "both") {
          if (!existsSync(join(opts.workdir, source))) continue;
          sources[source] = sources[source] === "static" ? "both" : "coverage";
        }
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
    // A static-only rebuild can't retry a failed coverage run — carry the
    // error forward rather than silently dropping it. Keyed to hash-unchanged
    // only: an old failed-attempt record is still informative even when the
    // dependency graph moved, and no coverage run happens here either way.
    if (prev !== undefined && prev.hash === hash && opts.runner === null && prev.coverageError !== undefined) {
      entry.coverageError = prev.coverageError;
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
