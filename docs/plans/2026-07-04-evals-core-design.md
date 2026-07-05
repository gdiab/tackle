# Evals core (Phase 1, slice 1 of 3) — design

Date: 2026-07-04 · Status: approved design, pre-plan
Prior art: SPEC.md "Self-measurement" + "Phased build roadmap / Phase 1"; bdfinst/agentic-dev-team evals apparatus (shapes borrowed, code not portable).

Phase 1 decomposes into three specs built in order: **(1) this evals core**, (2) telemetry + decisions.md, (3) the throwaway portability spike. This doc covers slice 1 only.

## What it is

Live-turn eval fixtures with model-free grading, a fingerprint replay cache, and derived flaky-quarantine, surfaced as a `tackle eval` command group plus a minimal CI workflow that re-grades from the cache at zero token cost. This is the smallest version of "the harness knows itself": recorded evidence of what a turn did, graded by assertions, tracked for flakiness, committed to git.

Approach chosen: first-class `src/evals/` module + `tackle eval` CLI (over a gated-vitest layer, which fights quarantine's non-binary states, and over porting bdfinst's claude-specific bash).

## Fixture format

A fixture is a directory: `evals/fixtures/<name>/` containing `manifest.json` and an optional `seed/` tree.

```json
{
  "name": "create-file",
  "description": "Phase 0 smoke codified: trivial write task completes on subscription billing",
  "prompt": "Create a file named hello.txt containing exactly the word: hello",
  "effort": "low",
  "timeoutSeconds": 300,
  "expectations": [
    { "kind": "status", "equals": "completed" },
    { "kind": "billing", "equals": "subscription" },
    { "kind": "fileExists", "path": "hello.txt" },
    { "kind": "fileContains", "path": "hello.txt", "text": "hello" }
  ]
}
```

- `seed/` files are copied into a fresh temp dir, `git init` + initial commit, and the turn runs with that as cwd. No `seed/` = empty repo. Seeds are plain checked-in files — no templating, no hooks — so they are hashable and readable by `ls`.
- Results live in `evals/results/<name>.json`, committed (they are the replay cache CI grades from).
- v1 exclusions (add later without format breaks): per-fixture adapter/model override (only the codex adapter exists), setup/teardown hooks (a fixture needing them means the seed should hold more files).

### v1 fixture set (3–5 turn-contract fixtures)

1. `create-file` — the Phase 0 smoke: completed + subscription + exact file content.
2. `edit-file` — seed contains a file; task edits it; `diffTouchesOnly` pins no collateral edits.
3. `passing-test` — task must produce a test that passes: `commandSucceeds` with `npx vitest run` in the fixture workdir.
4. `error-normalization` — a task engineered to fail (e.g. tool failure), pinning that `status` normalizes to the right closed-enum member rather than leaking free text.
5. (optional fifth once 1–4 are green; chosen from real regressions.)

## Grading vocabulary

Expectations are a closed discriminated union; one grader per `kind`; exhaustive switch (unknown kind = hard error, never a silent pass). A fixture passes when every expectation passes. Grade records keep per-expectation pass/fail + a one-line failure message.

Envelope assertions (against the `TurnResult`):
- `status` equals a closed-enum member.
- `billing` equals `subscription` (the SPEC's billing gate as an assertion).

Workdir assertions (against the repo after the turn):
- `fileExists` path.
- `fileContains` path + text, optional `exact: true` for whole-content equality.
- `diffTouchesOnly` globs — the turn's diff touched nothing outside allowed paths.
- `commandSucceeds` command — run in the fixture workdir, exit 0 passes.

**Replay grading is full-fidelity:** on replay, the grader re-materializes `seed/`, applies the recorded `workdirDiff`, and runs the same assertions — including `commandSucceeds` — against the reconstructed workdir. CI re-grades the actual bytes the turn produced, deterministically, zero tokens. Consequence: grading-vocabulary or expectation changes retroactively re-grade all cached runs for free.

## Fingerprint & replay cache

Fingerprint = SHA-256 over canonical JSON of the run-affecting inputs only:
- manifest run fields: `prompt`, `effort`, `timeoutSeconds` (NOT `expectations` — grading changes must not invalidate cached runs),
- `seed/` as sorted `(path, contentHash)` pairs,
- adapter name.

**Documented v1 approximation (same pattern as the test map's):** harness/adapter code changes and codex CLI upgrades do not invalidate the fingerprint even though they can change behavior. Hashing `src/adapter/**` would invalidate every cached run on any refactor and train the user to ignore staleness. Mitigation: every recorded run stores `authorship` (model) and the adapter CLI version, so drift is attributed even when not fingerprinted, and `tackle eval status` shows result age. Revisit trigger: when phase-level fixtures land and prompt templates become real files, those files join the hash.

Result file (`evals/results/<name>.json`):

```json
{
  "fixture": "create-file",
  "fingerprint": "sha256:…",
  "runs": [
    { "at": "2026-07-04T…", "adapterVersion": "codex-cli 0.142.4",
      "envelope": { "status": "…", "summary": "…", "usage": {}, "authorship": {} },
      "workdirDiff": "…",
      "grade": { "pass": true, "expectations": [] } }
  ]
}
```

- `runs` newest-first, capped at 10.
- **Fingerprint change resets `runs`** — pass-rates from different behaviors must never mix or the quarantine math lies.
- `tackle eval run`: fingerprint match + run exists → replay-grade only, unless `--force`; mismatch → live turn, new fingerprint, fresh history.
- CI (`tackle eval check`): recompute fingerprints from the repo; any mismatch = **stale-eval failure** ("re-run locally"), never a silent skip.

## Flaky-quarantine

State is **derived from the graded trailing window**, never curated — no quarantine.json, no second source of truth:

- **healthy** — every run in the window passes.
- **failing** — every run fails (a single-run history that fails is `failing`). A real signal: regression or wrong expectation; human decision either way.
- **flaky** — window contains both. bdfinst's "unreliable middle": visible, tracked, never deleted, never blocking.

Blocking policy (drives `check`'s exit code): states are derived from the fresh re-grade, then: `failing` blocks; `flaky` warns, exits zero; `healthy` passes; stale fingerprint blocks regardless of state. (A previously-healthy fixture that re-grades to `failing` therefore blocks with no special case.) Exit from quarantine is by evidence: failures age out of the 10-run window, or the fingerprint changes and history resets. Because replay re-grades, an expectation change can flip a fixture's state without a new run — intended: state always reflects current expectations against recorded behavior.

## CLI surface

`tackle eval` command group, following the `tackle map` group's flag/output conventions:

- `tackle eval run [fixture…]` — attended, token-spending. No args = all fixtures. Replay-grade on fingerprint hit (says so); live turn on miss; `--force` bypasses. Exit nonzero if any grade fails.
- `tackle eval status` — the state table: fixture, state, pass-rate over window, runs recorded, last-run age, model. Always exits 0. States shown by `status` come from the stored grades (refreshed on every `run`, including replays); after an expectations-only edit they can lag until the next `run` or `check` — `check` is always the fresh-re-grade authority.
- `tackle eval check` — unattended/CI: replay-only, never spends a token. Stale → fail; `failing` → fail; `flaky` → warn/pass; clean → pass.

Live runs go through the same adapter path as `tackle turn`, so `billingType` lands in every recorded envelope (subscription-before-API assertion rides along).

## Venue split

Local runs, CI replays. Live turns execute only locally (attended, subscription auth). CI has no credentials and spends no tokens; it runs `tackle eval check` against committed results. The stale-eval failure is what guards against forgetting to re-run after changing a prompt or seed.

## Minimal CI workflow (in scope)

The repo has no CI today. This slice adds `.github/workflows/ci.yml`: checkout, setup Node (26), `npm ci`, `npx tsc --noEmit`, `npx vitest run`, build, then `node dist/cli.js eval check`. No credentials, no tokens, deterministic.

## Module layout & testing

`src/evals/`: `manifest.ts` (load/validate), `materialize.ts` (seed → temp git repo; also replay reconstruction via apply-diff), `grade.ts` (the union + graders), `fingerprint.ts` (canonical JSON + SHA-256), `results.ts` (result-file read/write/window), `state.ts` (healthy/failing/flaky derivation), `runner.ts` (orchestrates run/replay), CLI wiring in `src/cli.ts` alongside the map group.

Module tests are model-free via the existing `test/fakes/` adapter binaries (runner reaches the adapter through the same seam as `tackle turn`). Unit targets: materializer, every grader kind, fingerprint canonicalization/stability, replay reconstruction, state derivation. One end-to-end test: `eval run` → result file → `check` → `status` against a temp fixture dir with the fake adapter. Zero tokens in the suite.

The real fixtures (`evals/fixtures/*`) get their first live runs manually via `tackle eval run` once the machinery merges; those recorded results are then committed — the same dogfood step the test map used.
