# Telemetry + decisions.md (Phase 1, slice 2 of 3) — design

Date: 2026-07-06 · Status: approved design, pre-plan
Prior art: SPEC.md "Self-measurement" (cost/friction telemetry, persistent decisions.md); bdfinst/agentic-dev-team `session-digest/v1` (vocabulary adopted, storage model consciously not — see "Relation to bdfinst" below).

Phase 1 decomposes into three specs built in order: (1) evals core (shipped 2026-07-05, `9810bc0`), **(2) this telemetry + decisions.md slice**, (3) the throwaway portability spike. This doc covers slice 2 only.

## What it is

Two pieces of "the harness knows itself" that the evals slice didn't cover:

1. **Cost and friction telemetry.** Every real turn appends one self-contained record to a per-repo, gitignored, append-only ledger (`.tackle/telemetry/turns.jsonl`). A `tackle telemetry` report computes token totals, billing split, metered-equivalent cost, per-file churn, and failure counts fresh from the ledger on every read. This is the instrument that can falsify the subscription bet (SPEC: "telemetry may falsify it") — it produces the "what would this have cost on the API" number.
2. **A persistent `decisions.md`.** Dated, ID'd entries with rejected alternatives in `.tackle/decisions.md`, written through a `tackle decision` CLI and auto-appended by the review gate at the two moments something decision-shaped actually happens (workflow commit; escalated approval).

Approach chosen: **per-turn JSONL ledger + compute-on-read digest** (over maintaining an aggregate `session-digest.json` via read-modify-write, which loses per-turn resolution, is corruptible mid-write, and turns every schema change into a data migration; and over ledger-plus-persisted-digest-snapshots, whose trend history was explicitly deferred with the "capture + basic report" scope decision). Same pattern the evals slice proved: raw evidence stored, derived views computed on read.

## Relation to bdfinst (SPEC's "adopted, not invented")

Verified against the actual repo 2026-07-06: bdfinst's `session-digest/v1` is an **aggregate** document derived by parsing Claude Code transcripts after the fact — token totals + cost by model/skill/thread, plus friction counters (`repeated_file_edits`, `retried_bash_commands`, stuck-verify detection, correction turns, gate bypass rate), `schema: "<name>/vN"` tags on every record, integer micro-dollar costs, counts-only persistence for privacy. The SPEC's phrase "churn heatmap" has no literal counterpart there; it maps to `rework.repeated_file_edits` (per-file edit counts, basenames only).

What we adopt: the digest **vocabulary** (token/cost totals, per-file churn, failure counters), the `schema` version-tag discipline, and fail-visible cost accounting. What we consciously do differently: our source is the adapter seam, not transcripts — we can (and do) record **per turn**, which his pipeline structurally cannot; the aggregate view becomes a report computed over per-turn records rather than a stored document. We also keep full relative paths, not basenames: the ledger is local-only and gitignored, so his privacy constraint doesn't apply, and basenames wreck churn analysis in any repo with two `index.ts` files.

## Turn ledger

### Capture seam

New module `src/telemetry/`. The capture primitive is a function, not a wrapper class:

```ts
recordedRun(adapter, req, { repoDir, context }): Promise<TurnResult>
```

It times the call, runs `adapter.run(req)`, appends one JSON line to `<repoDir>/.tackle/telemetry/turns.jsonl`, and returns the result unchanged. Call sites swap `adapter.run(...)` for `recordedRun(...)` — one line each, and duration capture can't be forgotten. The four real-turn sites and their context tags:

| Site | Context |
| --- | --- |
| `cli.ts` turn command | `turn` |
| `phase.ts` runPhase | `phase:specs` / `phase:plan` / `phase:build` / `phase:pr` |
| `review.ts` reviewer turn | `review:reviewer` |
| `review.ts` fix turn | `review:fix` |

The eval runner stays untouched: eval turns run in temp dirs, and their evidence already lives in `evals/results/`.

**Telemetry failure never fails the turn.** Append errors are caught and warned to stderr; losing a telemetry line must not halt paid work. (Same posture for the gate auto-record below: the commit already happened.)

### Record shape (`turn-record/v1`)

```json
{
  "schema": "turn-record/v1",
  "at": "2026-07-06T17:00:00.000Z",
  "context": "phase:build",
  "durationMs": 184201,
  "status": "completed",
  "billingType": "subscription",
  "authorship": { "adapter": "codex", "model": null, "effort": "medium" },
  "tokens": { "inputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0 },
  "filesTouched": [ { "path": "src/foo.ts", "insertions": 12, "deletions": 3 } ],
  "sessionId": "…",
  "transcriptRef": "…"
}
```

- `filesTouched` is derived from the turn's `workdirDiff` (numstat-style per-file line counts; the hardened diff-parsing posture from the evals slice applies — a diff that won't parse yields an empty list plus a warning, never a crashed turn).
- **No content is stored** — no prompt, no diff body. `transcriptRef` already points at the full evidence.
- Append-only JSONL, one self-contained line per turn, no read-modify-write anywhere in the capture path.

### Storage and git policy

`.tackle/telemetry/` is per-repo (turns recorded where they ran, consistent with the files-on-disk state model) and **gitignored** — usage data never pollutes the target repo's history or leaks in a public repo. Loss on clone is accepted for v1; cross-repo/cross-machine aggregation is a later problem the per-turn ledger keeps open.

## `tackle telemetry` report

One command: `tackle telemetry` with `--cwd`, `--json`, and `--since <duration>` (`7d`, `24h`; default: all records). It reads the ledger, skips malformed lines with a stderr warning (forgiving-reader posture, same as the test map), and computes every figure fresh on read. Report sections:

- **Turns** — count, split by context and by status. Non-`completed` statuses per context are the v1 "which sessions hurt" signal.
- **Tokens** — the four counters totalled and split by model (`authorship.model`; `null` shown as the adapter's default-model label).
- **Billing** — turn counts and token totals per `billingType`. A nonzero `metered` row is the subscription-gate alarm made visible.
- **Metered-equivalent cost** — what the window's tokens would have cost on the API, per model and totalled, from the pricing table. Real metered turns price identically and are labelled actual rather than hypothetical. This is the subscription-bet number.
- **Churn** — per-file aggregation across the window: touch count, total insertions/deletions; files touched more than once, top 20 by touches. bdfinst's `repeated_file_edits`, upgraded with line counts the diffs give us free.

### Pricing table

`src/telemetry/pricing.ts`: a checked-in typed const mapping model-name patterns to $ per Mtok for input / cache-read / output (reasoning tokens price as output — that is how both vendors bill). It carries an `asOf` date printed in the report footer so staleness is visible. A per-adapter default-model mapping lives next to it to resolve `authorship.model: null`.

**Unknown models fail loud, not silent-zero:** tokens attributed to a model with no pricing row (including a `null` model whose adapter default also misses) are totalled separately and reported as an `unpriced` line naming the model, so a new model never quietly deflates the cost figure.

## decisions.md

### File and format

`.tackle/decisions.md` in the target repo, human-readable markdown, entries appended at the bottom:

```markdown
## D-003 — 2026-07-06 — Ship telemetry ledger as JSONL

- **Decision:** per-turn append-only ledger, digest computed on read
- **Rejected:** aggregate session-digest.json (read-modify-write, loses per-turn resolution)
- **Source:** human
```

The markdown **is** the store — no shadow JSON. `src/decisions/` gets a small parse/append module: append re-reads the file, takes max ID + 1 (`D-001`, `D-002`, …), writes atomically. A file that fails to parse blocks `add` with a clear error rather than guessing IDs. `Source` is `human` or `workflow`.

### CLI

- `tackle decision add <title> --decision <text> [--rejected <text>]…` — `--decision` is required, `--rejected` optional and repeatable
- `tackle decision list` — one line per entry: ID, date, title, source.

No edit, no delete: it is an append-only log by design.

### Auto-record at gates — deliberately narrow

Not every approval: five "approved" entries per workflow is audit noise that trains the reader to ignore the file. Exactly two events write automatically, both in the review phase (the only gate where something decision-shaped happens), through the same append path as the CLI:

1. **Workflow commit** — when review approval commits: title from the request's first line, decision = "committed `<sha>` after N review round(s)", source `workflow`. One entry per shipped workflow.
2. **Escalated approval** — when the human approves through a circuit-breaker or budget-exhausted escalation, the entry additionally records "committed despite N unresolved blocking finding(s): `<one-line summaries>`" with rejected-alternative "reject and discard the review". The knowingly-accepted risk is the entry that matters most later.

### The committed-ness wrinkle

Tackle's own commit flow excludes `.tackle/` from every commit (deliberate: harness state is never part of a reviewed diff) and keeps that behavior — tackle never commits decisions.md itself. "Survives session resets" is delivered by the file being durable on disk; surviving *clones* is the repo's call via a gitignore negation, documented and applied to this repo:

```gitignore
.tackle/*
!.tackle/decisions.md
```

## Error handling summary

- Ledger append or auto-decision write fails → warn to stderr, turn/workflow proceeds.
- Malformed ledger lines → skipped with a warning at report time; the rest of the report still renders.
- Unparseable diff → empty `filesTouched` + warning, record still written.
- Unpriced model → separate `unpriced` total, named in the report, never $0.
- Unparseable decisions.md → `decision add` (and the gate auto-record) refuse with a clear error; nothing is guessed.

## Testing

Unit tests per module: record shape and `recordedRun` passthrough (result identity, duration, error swallowing), JSONL append/read, report math including the unpriced and malformed-line paths, pricing lookup and default-model resolution, decisions parse/append/ID sequencing and the unparseable-file refusal.

End-to-end through `buildProgram` with the existing fake-adapter injection: run a fake workflow to commit, then assert the ledger lines (one per turn, correct contexts), the report output over them, and the auto-recorded decision entry — including an escalation path asserting entry shape 2. No live turns anywhere in the suite.

## v1 exclusions (add later without format breaks)

- Trend history / persisted digest snapshots (bdfinst's `slim_record` pattern) — the ledger keeps everything needed to add it.
- Cross-repo and cross-machine aggregation (bdfinst's per-host sync-repo pattern) — per-repo ledgers keep it open.
- Deeper friction derivatives (retried-command detection, stuck-verify loops, correction-turn counting) — need transcript parsing, out of scope; per-turn status-by-context is the v1 signal.
- Eval-turn telemetry — already recorded in `evals/results/`.
- decisions.md edit/supersede semantics — append a new entry that references the old ID instead.
