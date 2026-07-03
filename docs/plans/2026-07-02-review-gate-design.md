# Pre-commit review gate (tackle-483) — design

Approved design from brainstorm, 2026-07-02. Implements SPEC.md "Pre-commit
review", "Cross-model review as a first-class gate", and the artifact-integrity
hole flagged in `2026-07-02-workflow-spine-notes.md`.

## Scope

Three deliverables, one bead:

1. A `review` phase between `build` and `pr` that loops a cross-model reviewer
   against the frozen build diff until clean (bounded), then — after the human
   gate — stages and commits, refusing to commit anything whose hash does not
   match what the reviewer passed.
2. A minimal Claude Code reviewer adapter, so the cross-model rule (reviewer
   runtime != author runtime, fail closed on unknown authorship) is enforced
   for real from day one.
3. Artifact pinning: hash every approved artifact into `workflow.json` at
   approval time; every consumer verifies before trusting.

Out of scope: branch policy (commits land on the current branch), routing
tables, review panels, moving workflow state out of the workdir.

## Architecture

The spine becomes `specs -> plan -> build -> review -> pr`.

- `review` joins `PhaseName`, `PHASE_ORDER`, and the `SPINE` table.
  Artifact: `.tackle/review.md`. `entryFlag: null` — a workflow can never
  *start* at review; there is nothing to review without a build.
- `pr.predecessor` becomes `review`. The existing predecessor gate and the
  invalidation loop in `runPhase` then do the right thing unchanged:
  pr requires an approved review, and re-running build wipes review + pr.
- `tackle review` dispatches to a dedicated `runReviewPhase()` (decision:
  honest duplication over generalizing `runPhase` into a framework for one odd
  caller). It shares the state/artifact/presenter helpers and writes the same
  `workflow.json` phase-state shape, but owns its own control flow, because
  review runs two adapters in an alternating loop and ends in a git side
  effect — nothing like the one-adapter turn-retry loop the other four phases
  share.

## Review flow

1. **Preconditions.** Build is approved (predecessor gate). Cross-model check:
   the build turn's authorship record in `workflow.json` must name a different
   adapter than the reviewer; unknown authorship fails closed. **Drift check:**
   recompute the workdir diff; it must byte-match the frozen
   `.tackle/build.diff`, else halt ("tree changed since build was approved;
   re-run build").
2. **Reviewer turn.** Claude adapter. Prompt = frozen diff + hash-verified
   `.tackle/specs.md` (when the entry point produced one; workflows entered at
   plan or build have no specs artifact, so the reviewer gets the workflow
   request text as the requirement instead) + the structural review posture:
   block on missed simplifications and file-size explosions, not just
   correctness. The author's plan and transcript are withheld
   (SPEC isolation rule — re-importing the author's reasoning re-imports its
   blind spots).
3. **Clean verdict.** Write `review.md`, set `awaiting_approval`, present the
   human gate. On approval, run the commit chain (below).
4. **Findings verdict.** Author fix turn (Codex adapter) with the blocking
   findings fed back, re-freeze `.tackle/build.diff` from the new workdir
   diff, re-review. Bounded by `reviewLoopIterations` (default 2). Budget
   exhausted with blocking findings still open: escalate to the human gate
   with the unresolved findings presented — the human may approve anyway
   (commit proceeds) or reject.

## The commit chain

The bdfinst `.review-passed` mechanism, enforced in orchestration because
Codex has no hook system:

    reviewer passes diff D
      -> record sha256(D) in workflow.json as the review-passed hash
      -> human approves the review gate
      -> recompute workdir diff; must hash to sha256(D), else halt
      -> git add -A   (.tackle/ is gitignored, so state stays out)
      -> staged diff must also hash to sha256(D), else halt
      -> git commit; message derived deterministically from the request +
         build summary (no model writes the commit message)
      -> record the commit SHA in workflow.json

(Implemented as a structural proof: `git add -A` followed by a porcelain-clean
check — with nothing left unstaged, staged == worktree == D, equivalent to a
second hash. The commit runs with hooks disabled: hooks live in turn-writable
`.git/` and would execute after the hash check.)

Any turn or human edit between review-pass and commit breaks the chain and
halts. Nothing unreviewed can ride along.

## Claude reviewer adapter

`src/adapter/claude/`, mirroring `src/adapter/codex/`. Drives
`claude -p --output-format json` as a one-shot non-interactive turn and
implements the same `Adapter` interface returning a `TurnResult`, so billing
gate, authorship, and transcript ref work unchanged.

- **Read-only, twice over.** The reviewer needs no tools (diff and spec are
  inlined), so the adapter invokes claude with tools disallowed (exact flag
  pinned in the plan phase against the installed CLI). Independently,
  `runReviewPhase` hard-fails if a reviewer turn produced a non-empty workdir
  diff: a reviewer that writes is a gate violation.
- **Billing, fail closed** (same shape as `codex/billing.ts`):
  `ANTHROPIC_API_KEY` in the allowed env -> `metered`; subscription OAuth
  detected -> `subscription`; can't tell -> `unknown`, which halts. The exact
  subscription probe (credentials file vs. result metadata) is pinned in the
  plan phase with a live check — macOS keeps credentials in the Keychain.
- **Authorship**: `{tool: "claude-code", model: <resolved>}` — the record the
  cross-model check compares against the build turn's `codex` record.

## Verdict format

The reviewer is instructed to end its output with a fenced JSON block:

```json
{ "verdict": "findings",
  "findings": [{ "severity": "blocking", "file": "src/x.ts", "line": 12,
                 "summary": "...", "detail": "..." }] }
```

`verdict` is `"clean"` or `"findings"`. Only `blocking` findings drive the fix
loop; `note` findings are recorded but do not block. An unparseable verdict is
a failed turn: it consumes a `deterministicRetries` attempt, then halts — a
gate that cannot read its measurement fails closed. Required fields
(`severity`, `file`, `summary`) are strict — any violation rejects the
verdict; malformed OPTIONAL fields (`line`, `detail`) are dropped from the
finding rather than rejecting, so a stringly-typed line number can't brick
the gate.

`.tackle/review.md` is the human-readable record: one section per round —
verdict, findings, fix-turn summary — so the human gate and later archaeology
read one file.

## Artifact pinning

`PhaseState` gains `artifactHash` (sha256 of artifact bytes), set inside
`presentGate` at the moment of approval — one place covers all phases. Build
approval additionally pins the hash of the frozen `build.diff`.

Consumers verify before trusting:

- `runPhase` input gathering checks each inlined artifact of an approved phase
  against its recorded hash.
- `runReviewPhase` checks `specs.md` before handing it to the reviewer and
  `build.diff` before review.

**Diff custody across fix rounds.** The hash pinned at build approval covers
round 1 only. Each fix turn legitimately rewrites `.tackle/build.diff`; when
it does, the runner re-freezes the diff and pins the new hash in the *review*
phase's state — custody of the diff passes from build to review at the first
fix turn. Round N's reviewer always reviews a diff whose hash review state
recorded, and the review-passed hash in the commit chain is the final round's.

Shipped refinement: the fix-round custody pin actually lives in
`build.diffHash` (updated at each re-freeze) rather than in review state, so a
killed loop can still resume — see the plan's "Design refinement" header for
the reasoning.

Mismatch halts: "`.tackle/specs.md` changed after approval; re-run specs (or
re-approve)".

**Accepted limitation, stated plainly:** `workflow.json` — and the rest of the
turn-writable workdir, including `.git/` — lives outside a turn-inaccessible
source, so a hostile turn could rewrite the hashes too. v1 defends against
accident and drift, not a malicious author. Hooks are neutralized at commit
time (see "The commit chain"); the rest of that surface is documented risk.
Moving state to a turn-inaccessible source is the noted future hardening
(SPEC already names it). The same boundary covers the stage window: a
turn-spawned background process could mutate the tree in the instants between
the pre-stage hash check and `git add`; closing it means committing the
verified tree via plumbing (`write-tree`/`commit-tree`), which is the v2
hardening.

## Policy and error handling

- The two `PolicyConfig` knobs reserved for this bead are finally consumed:
  `reviewLoopIterations` bounds fix rounds; `circuitBreakerThreshold` halts
  early when consecutive rounds return identical findings (a loop making no
  progress escalates to the human immediately instead of burning budget).
- Both reviewer and fix turns pass through the existing fail-closed billing
  gate (only `subscription` proceeds; no retry on billing halts).
- All failure behavior lives in the runner (worker/policy separation); the
  reviewer prompt never encodes control flow.

## Testing

Follows the established patterns:

- `test/fakes/claude` scripted fake (like `test/fakes/codex`) for adapter
  tests: billing detection, verdict parsing, read-only violation.
- Runner tests in temp git repos: loop budget, circuit breaker, tamper cases
  (edit `specs.md` after approval; dirty the tree after review-pass),
  commit-only-on-hash-match, escalation with unresolved findings,
  cross-model fail-closed on unknown/same-runtime authorship.
- Spine e2e test grows the review phase.
- Live smoke against the real `claude` CLI before the bead closes, as the
  spine did with Codex.
