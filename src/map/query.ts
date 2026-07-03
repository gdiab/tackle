import { relative, resolve, sep } from "node:path";
import { readTestMap } from "./store.js";
import type { TestMapFile } from "./types.js";

export type QueryResult =
  | { kind: "no-map" }
  | { kind: "unmapped" }
  | { kind: "mapped"; tests: Array<{ test: string; method: string }> };

export async function testsFor(workdir: string, sourcePath: string): Promise<QueryResult> {
  const map = await readTestMap(workdir);
  if (map === null) return { kind: "no-map" };
  const rel = relative(resolve(workdir), resolve(workdir, sourcePath)).split(sep).join("/");
  const testFiles = map.sources[rel];
  if (testFiles === undefined || testFiles.length === 0) return { kind: "unmapped" };
  return {
    kind: "mapped",
    tests: testFiles.map((test) => ({
      test,
      method: map.tests[test]?.sources[rel] ?? "static",
    })),
  };
}

export interface MapStatus {
  builtAt: string;
  mode: TestMapFile["mode"];
  testCount: number;
  sourceCount: number;
  coverageFailures: string[];
}

export function describeMap(map: TestMapFile): MapStatus {
  return {
    builtAt: map.builtAt,
    mode: map.mode,
    testCount: Object.keys(map.tests).length,
    sourceCount: Object.keys(map.sources).length,
    coverageFailures: Object.entries(map.tests)
      .filter(([, entry]) => entry.coverageError !== undefined)
      .map(([testFile]) => testFile)
      .sort(),
  };
}
