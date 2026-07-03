/** How an edge was established: static import graph, coverage run, or both. */
export type EdgeMethod = "static" | "coverage" | "both";

export interface TestEntry {
  /** sha256 of the test file's content at build time — the incrementality key. */
  hash: string;
  /** Repo-relative source files this test exercises, with per-edge provenance. */
  sources: Record<string, EdgeMethod>;
  /** Set when this test file's coverage run failed; its static edges are kept. */
  coverageError?: string;
}

export interface TestMapFile {
  version: 1;
  builtAt: string;
  /** "full" = imports + coverage; "static-only" = imports only. */
  mode: "full" | "static-only";
  /** Repo-relative test file path -> entry. */
  tests: Record<string, TestEntry>;
  /** Inverted index: repo-relative source file -> sorted test file paths. */
  sources: Record<string, string[]>;
}
