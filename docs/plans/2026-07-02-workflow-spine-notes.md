# Workflow spine — execution notes

Plan: [2026-07-02-workflow-spine.md](2026-07-02-workflow-spine.md) · bead tackle-atq · branch `workflow-spine`, 9 commits.

## Outcome

All 7 tasks implemented via subagent-driven development (fresh implementer + reviewer per task). Per-task reviews: 6 clean first pass, 1 fix round (Task 5: `--fresh` without an entry-capable invocation was silently dropped). Final whole-branch review found 4 Important findings, all fixed and verified in one commit (1842f85):

1. Stale questions file survived a successful clarification round-trip and injected outdated "authoritative" answers into later `--redo` prompts — now removed on success.
2. Billing gate passed `unknown` silently — now fails closed, only `subscription` passes (decision D-005). This gap was **plan-sourced**: the plan narrowed SPEC's `billing_type == subscription` gate to metered-only; watch for the same narrowing pattern in tackle-483's budgets.
3. Request amendment half-applied on resume paths (could persist a request the artifact was never generated from) — now applies only when a turn actually runs; early-return paths inform that the argument was ignored.
4. `--skip-specs`/`--trivial` mid-workflow silently degraded to a request amendment — now halts and asks for `--fresh`.

Plus minors: non-object JSON guards in state.ts, atomic `workflow.json` writes (tmp + rename), `deterministicRetries` clamped to >= 0, predecessor-`needs_clarification` blocking test, killed-process re-run trade documented in code.

Suite: 115 tests green, typecheck + build clean.

## Live smoke (2026-07-02, codex-cli 0.142.4)

In a scratch git repo: `printf 'y\n' | node dist/cli.js specs "add a hello-world shell script named hello.sh that prints 'hello, tackle'" --cwd <scratch>`

- Real Codex turn on subscription auth; agent wrote a genuine requirements doc to `.tackle/specs.md` (problem/behavior/acceptance/non-goals) and explicitly noted it skipped the questions file because the request was unambiguous — the clarification preamble is being read and reasoned about.
- Approval gate presented artifact + summary, `y` approved, exit 0.
- `workflow.json`: specs `approved`, full authorship record (`adapter: codex`, `billingType: subscription`, transcriptRef, sessionId).
- `tackle status`: request/entry lines plus `specs approved`, later phases `pending`.

## Deferred (known, not blocking)

- `spine.ts` `entryFlag` field is metadata the CLI doesn't consume (flags are hardcoded there) — wire or drop when touched next.
- `tackle status` doesn't surface the questions-file path for `needs_clarification` or the halt reason.
- No `.tackle/` lockfile — two concurrent `tackle` commands last-write-win; matters when unattended mode arrives.
- For tackle-483: a build turn can rewrite already-approved upstream artifacts (e.g. edit `.tackle/specs.md`) before the pr/review phase inlines them; the review gate should hash approved artifacts into `workflow.json` at approval time, or re-read from a turn-inaccessible source.
