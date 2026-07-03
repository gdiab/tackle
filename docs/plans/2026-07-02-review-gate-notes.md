# Review gate (tackle-483) — execution notes and live smoke evidence

Plan: `2026-07-02-review-gate.md` · design: `2026-07-02-review-gate-design.md` ·
branch `review-gate`, 9 code tasks + live smoke, subagent-driven (fresh
implementer + reviewer per task, opus reviewers on the two loop-core tasks).

## Review yield (the SDD flow keeps earning its keep)

Per-task reviews: 5 clean first pass, 4 with accepted findings — every accepted
finding was a defect in the PLAN's reference code, not implementer error:

- Task 1: blanking an approved artifact bypassed the hash tamper check
  (`readArtifact` collapses blank to null → treated as "phase skipped").
  Fixed fail-closed; same patch propagated into the plan's Task 7 code.
- Task 6: explicit `"findings": null` slipped through `?? []` — a findings
  verdict with a null list would have read as clean and passed the gate.
- Task 8 (from Task 7's review, swept into 8): resumed escalation gates lost
  their "unresolved blocking findings" warning (`gateDetail` now persisted);
  porcelain `.tackle` exemption tightened from prefix-match.
- Task 8: a fix turn that empties the tree now halts fail-closed instead of
  crashing uncleanly at `git commit` with a stuck pending gate.

Two NEEDS_CONTEXT stops (both Task 7, both real plan bugs the implementer was
right to refuse to improvise around):

1. `git add -A -- . ':(exclude).tackle'` exits 1 whenever an ignored path is
   named in ANY pathspec, even an exclude (git 2.50/Apple Git-155,
   `advice.addIgnoredFile`). Replaced with `git add -A` + `git reset -q HEAD
   -- .tackle`, verified in both ignore states.
2. The cross-model test couldn't trip: it seeded turn *authorship* but the gate
   compares `reviewer.name`; `scriptedAdapter` gained an optional name param so
   the comparison is exercised for real.

Adjudicated-declined (recorded, final review consulted): malformed OPTIONAL
finding fields (`line`/`detail`) are dropped rather than rejecting the verdict —
deliberate leniency for real LLM output; required fields stay strict.

## Live smoke (real CLIs, scratch repo)

- `tackle build --trivial` (real Codex, subscription billing) → hello.ts,
  frozen diff, gate approved.
- First `tackle review` **halted fail-closed**: claude subprocess reported
  "Not logged in". Bisected live: the adapter env allowlist (PATH+HOME) was
  missing **USER**, which claude needs to resolve its macOS Keychain
  credentials. One-line fix (38f2f9d). The halt itself was the gate machinery
  working — no verdict, one retry, halt with transcripts on disk.
- Re-run: real Claude reviewed the real Codex diff — clean verdict with a
  correct fenced JSON block on the first try, billing detected `subscription`
  via Keychain `claudeAiOauth.subscriptionType`, gate approved, commit
  `360a38c7` landed with the deterministic message (request subject + build
  summary), `.tackle` excluded, tree clean, `tackle status` shows the chain.
- Live tamper test: second workflow (`--fresh`), review passed, gate DECLINED,
  file edited, review re-run and gate approved → **"working tree changed
  between review and commit; refusing to commit"**, review halted. The
  bdfinst `.review-passed` mechanism verified end to end against real tools.

## Final whole-branch review (fable) — outcome

Two blockers found and fixed in 3b872c8, both with adversarial regression
tests that failed before the fix:

1. `presentGate` could approve a phase whose artifact was deleted while
   `awaiting_approval`, recording no pin — now refuses before presenting
   (also closes a TOCTOU: the pin is taken from the same pre-gate read the
   human approves).
2. The chain commit executed repo git hooks — turn-writable `.git/hooks/`
   could mutate the index after the hash check. Commits now run with
   `core.hooksPath=/dev/null` + `--no-verify`; `.git/` is named in the
   design doc's accepted-limitation text.

Also pinned in the same commit: USER env passthrough (a revert now fails a
test), the fix-turn metered-billing halt, and the drifted billing-halt copy
aligned between phase.ts and review.ts. Design doc reconciled (structural
proof wording, custody refinement, verdict optional-field leniency).

## Deferred minors (recorded, non-blocking)

- Reviewer read-isolation is a tool disallow-LIST (fragile to new CLI tools);
  writes have the purity-check backstop, reads don't. Allowlist when the CLI
  supports it.
- `tackle review --redo` after a landed commit drops `commitSha` from state
  and halts with a misleading drift message (safe, but the UX lies); untested.
- Fix prompt hands the author `state.request` while the reviewer sees the
  specs-preferred requirement (documented asymmetry; findings carry the
  specifics).
- Three near-identical scripted-clean-reviewer fakes across test files.
- `vitest.config.ts` testTimeout 15s→30s masks CPU-contention flakiness whose
  root cause is `test/exec.test.ts`'s unref'd `sleep 30` grandchildren — a
  bounded-sleep or pool-concurrency fix is the elegant version.

## Environment facts pinned along the way

- `claude -p` needs `USER` (Keychain), reads the prompt from stdin, and reports
  `total_cost_usd` even on subscription (cost is not a billing signal).
- git exits 1 when an ignored path appears in any pathspec of `git add`.
