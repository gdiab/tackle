# Spike: Sandcastle (`@ai-hero/sandcastle`) as the adapter layer

Date: 2026-07-02 · Bead: tackle-s5y · Verdict: **BORROW THE SHAPE**

Repo: `mattpocock/sandcastle` (personal account, not an org). MIT, ~6.6k stars, v0.12.0, created 2026-03-17, last push 2026-06-29. TypeScript, Effect-based internals with deliberately Effect-free public types. Bus factor 1 (mattpocock: 1,025 commits; next human: 4). Explicitly unstable API — breaking changes ship as patch changesets pre-1.0.

## The contract, as actually built

Provider interface (`src/AgentProvider.ts`, all six providers in one file):

```ts
interface AgentProvider {
  name: string;
  env: Record<string, string>;
  captureSessions: boolean;
  sessionStorage?: AgentSessionStorage;                          // per-provider
  buildPrintCommand(opts: AgentCommandOptions): PrintCommand;    // { command, stdin? }
  buildInteractiveArgs?(opts: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];            // text|result|tool_call|session_id|usage
  parseSessionUsage?(content: string): IterationUsage | undefined;
}
```

A provider is a *command builder + line parser*, not an executor — execution lives in the orchestrator/sandbox. `run()` returns `RunResult { iterations[{sessionId, sessionFilePath, usage}], completionSignal?, stdout, commits[{sha}], branch, resume?(), fork?() }`. Success is a substring completion-signal match; every failure is a thrown tagged error.

## Gap table: TurnResult field → Sandcastle equivalent

| TurnResult field | Sandcastle | Notes |
|---|---|---|
| `status` closed enum | **missing** | Signal-match = success; failures thrown. Refusal is indistinguishable from finished-without-signal. |
| `workdir_diff` | **missing** (partial) | Gives `commits[]`/`branch`/worktree path; no diff artifact. |
| `transcript_ref` | ✅ `sessionFilePath` | Best-in-class: session JSONL captured per iteration, cwd-rewritten. |
| in-window summary | ~ structured output | Prompt-mandated XML tag + resume-based retry (ADR 0010). Steal this. |
| `authorship` | ~ implied by call args | Provider name/model/effort exist but aren't echoed on the result. |
| `usage.tokens` | ✅ | Claude via session JSONL; Codex via `turn.completed` event, cached-token normalization (ADR 0005: raw tokens only). |
| `usage.billing_type` | **missing** | No concept anywhere; nothing to gate on. |

Sandcastle has (and TurnResult lacked): multi-iteration completion-signal loop, resume/fork continuations, AbortSignal, live stream events, structured output with schema, lifecycle hooks, branch strategies, idle + completion-grace timeouts.

## Why not BUILD ON IT — three structural mismatches

1. **Billing-type assertion contradicts its auth model.** The provider-evaluation doc mandates env-based API-key auth as a must-have; the subscription-in-sandbox issue (#191) was wontfixed; ADR 0015's sanctioned subscription path is *turning the sandbox off* (`noSandbox()`). A `billing_type` gate isn't a contributable gap — it reverses a documented decision of a solo-maintained project.
2. **Tackle's v1 mode is Sandcastle's weakest.** `noSandbox()` inherits full `process.env` (`src/sandboxes/no-sandbox.ts:51`) — the declared-key env allowlist (`src/EnvResolver.ts`) only exists in container mode. The `ANTHROPIC_API_KEY`-unset guarantee can't be enforced through it without mutating global env per turn, which breaks under later parallelism.
3. **Result-shape philosophy differs.** Throw-on-failure + signal-match maps lossily onto `completed|refused|timeout|tool_error|budget_exceeded`.

## What Tackle steals nearly verbatim

- **The provider decomposition** (command builder + defensive per-line JSON parser + optional session storage + optional usage parser) — this is the adapter seam.
- **Battle-tested CLI recipes:** `claude --print --verbose --output-format stream-json --model M --effort E -p -` (prompt on stdin); `codex exec --json --dangerously-bypass-approvals-and-sandbox -m M -c model_reasoning_effort="E"`; resume/fork verbs (`claude --resume <id> [--fork-session]`, `codex exec resume|fork <id>`); stdin-over-argv (~128KB argv limit); Codex errors arrive on stdout.
- **Usage normalization:** Codex `cached_input_tokens` → cache-read with remainder as input (avoids double counting); raw tokens, no derived percentages.
- **Session semantics:** provider-owned storage (ADR 0012), resume-is-one-iteration (ADR 0011), fork-is-session-only (ADR 0018), filesystem-backed-only (ADR 0016). `sessionFilePath` *is* `transcript_ref`.
- **Structured output with resume-based retry** for the model-written summary.
- **`completionTimeoutSeconds`** grace window (children holding stdout open — a failure mode Tackle will hit).
- **`mergeProviderEnv` throw-on-overlap** and the provider-evaluation questionnaire as the adapter acceptance checklist (minus the API-key must-have).

## Standing use

Treat `mattpocock/sandcastle` as the reference implementation to diff against when Codex/Claude CLI flags drift. Nothing in its design argues against TurnResult's additions (`status` enum, diff-as-artifact, echoed authorship, `billing_type`); it simply never needed them.
