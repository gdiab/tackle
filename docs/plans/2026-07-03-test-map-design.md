# JS/TS source-to-test dependency map (tackle-5lk) — design

Approved design from brainstorm, 2026-07-03. Implements the SPEC.md Phase 0
deliverable "JS/TS map-builder": the TDAD source-to-test dependency map that
makes targeted test-first guidance possible. Per SPEC, the test-first rule
stays advisory until a map exists; this bead ships the map and its first live
consumer (the build-phase prompt), not a blocking gate.

## Scope

Three deliverables, one bead:

1. A map builder that produces `.tackle/test-map.json` from two evidence
   sources: the static import graph of test files (TypeScript compiler API)
   and per-test-file coverage runs (vitest). Coverage attribution is Tackle's
   extension over TDAD's static-only map.
2. A cached, incremental store plus a query API: entries are keyed by
   test-file content hash, so unchanged test files skip both re-parsing and
   the coverage re-run; queries return the tests for a source file with
   per-edge provenance.
3. Prompt injection: when the map exists, the build-phase prompt points the
   agent at it and instructs consult-before-edit, run-the-mapped-tests, and
   failing-test-first. When it does not exist, the current advisory sentence
   stays — the SPEC's advisory-until-map semantics.

Out of scope: a blocking test-first gate (enforcement/override/UX is a future
bead), jest and other runners (vitest-only v1 behind a runner interface),
non-JS/TS stacks, watching/auto-rebuild.

## Map semantics

- **Edge**: source file → test file, tagged with provenance `static`
  (import graph), `coverage` (executed statements in a per-test coverage
  run), or `both`. Provenance is kept because the two sources fail
  differently: static edges survive when tests can't run; coverage edges
  catch dependencies imports can't see (DI, dynamic imports, fixtures).
- **Static edges**: for each test file, extract imports with
  `ts.preProcessFile`, resolve with `ts.resolveModuleName` against the
  repo's tsconfig (paths/baseUrl/extension probing come free), and walk
  transitively so `test → helper → source` still maps. Only in-repo,
  non-test, non-node_modules files become edge targets.
- **Coverage edges**: run `vitest run <testfile> --coverage` per test file
  with a JSON reporter into a temp dir; any source file with at least one
  executed statement becomes an edge.
- **Unmapped is a signal**: a source file absent from the map means "no test
  is known to exercise this" — exactly the case where the agent should write
  a test first. The query API reports it explicitly rather than returning an
  empty list indistinguishable from an error.

## Module layout

New `src/map/` directory, one concern per file, matching the existing style:

- `testfiles.ts` — test discovery by glob heuristics (`*.test.*`, `*.spec.*`,
  `__tests__/`), rooted at the workdir.
- `imports.ts` — static edge extraction and transitive resolution (TS
  compiler API). `typescript` moves from devDependencies to dependencies.
- `coverage.ts` — the per-test-file coverage runner behind a small interface
  (vitest is the only v1 implementation) so jest can slot in later.
- `builder.ts` — orchestration and incrementality: discover, recompute static
  edges for every test file on every build (the walk is cheap — no type
  checking), drop deleted entries, merge edges with provenance.
  Hash-based reuse applies only to coverage evidence, and only when the
  static dependency set is unchanged too: when a test file's hash *and* its
  previous static edge set are both unchanged, its previous coverage-derived
  edges are merged onto the freshly computed static set instead of
  re-running coverage. If the static set differs — a transitively imported
  helper gained or lost an import — the coverage evidence is stale and is
  not reused; a coverage run happens instead when a runner is available.
- `store.ts` — read/write `.tackle/test-map.json`: versioned (`version: 1`),
  atomic write via tmp+rename, same validation posture as
  `workflow/state.ts`. Holds per-test-file records (hash, sources, method,
  coverage failure notes) and the inverted source→tests index.
- `query.ts` — `testsFor(sourcePath)` with provenance and the explicit
  unmapped result; a staleness summary for `map status`.

## CLI surface

- `tackle map build` — build or incrementally refresh the map.
  `--no-coverage` skips coverage runs (static-only build) for repos where
  running the suite is too expensive or broken.
- `tackle map query <file>` — print the tests for a source file, with
  provenance, or the explicit unmapped notice.
- `tackle map status` — map age, entry counts, stale/failed entries.

## Prompt injection

`buildPhasePrompt` gains a map-aware section for the build phase only:

- Map present: state the map path, instruct the agent to look up the tests
  for every source file it is about to modify (via `tackle map query` or by
  reading the JSON), run those tests, and write a failing test first for new
  behavior. Unmapped files are called out as "write the test first" cases.
- Map absent: today's single advisory sentence, unchanged.

The map is injected as a pointer, not inlined content — SPEC names it a
"static text file queried at runtime," and inlining a large repo's map would
blow the prompt for no gain.

## Error handling and degradation

The map must never make the workflow worse than having no map (the TDAD
lesson, inverted). Concretely:

- A coverage run failing for one test file records the failure in that entry
  and keeps its static edges.
- vitest or `@vitest/coverage-v8` missing in the target repo degrades the
  whole build to static-only with a printed warning.
- Missing/unparseable tsconfig falls back to default compiler options.
- Map build failures never block spine phases; the build phase simply runs
  with the advisory prompt.

## Testing

- Unit: fixture mini-repos under `test/fixtures/` for discovery, import
  resolution (including a tsconfig-paths alias case), transitive walking,
  merge/provenance, and incrementality (hash-unchanged entries untouched).
- Integration: one real tiny vitest project (existing `test/fakes` pattern)
  exercising the coverage runner end-to-end, plus the degradation paths
  (coverage provider missing, one test failing).
- Dogfood: build the map for tackle's own repo in a test — static-only
  (`--no-coverage` path), so the suite doesn't recursively run itself — and
  assert known edges (e.g. `test/workflow-state.test.ts` ↔
  `src/workflow/state.ts`).
- Prompt: snapshot-style assertions that the build prompt includes the map
  section when the map exists and the advisory sentence when it doesn't.
