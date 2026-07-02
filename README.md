# Tackle

A bespoke agentic software-development harness.

The name carries the thesis: tackle is the rigging and gear that does the work, and "tackle the problem" is the verb. The harness is the durable kit; the runtime is the engine you clip into it.

Core bet: the agent runtime (Claude Code, Codex CLI, a local model) is becoming a commodity. The orchestration, gates, evals, and self-improvement loop wrapped around it are the durable part worth owning. Build that as the product; treat the runtime as a slot.

Full spec: [`SPEC.md`](./SPEC.md). Canonical copy lives here now; the 2nd-brain vault note is the working/blog-draft copy going forward.

## Usage

    tackle turn "<prompt>" [--cwd <dir>] [--effort low|medium|high] [--model <m>] [--timeout <seconds>]

Runs a single adapter turn (currently Codex CLI) and prints the full `TurnResult` as
pretty JSON to stdout; exits 0 iff the turn completed.

## The workflow spine

Phase-gated flow per SPEC.md: each phase runs one adapter turn, writes its artifact
under `.tackle/`, and stops at a blocking approval prompt. State lives in
`.tackle/workflow.json`; a killed run resumes from those artifacts.

    tackle specs "add a widget"     # writes .tackle/specs.md, asks for approval
    tackle plan                     # writes .tackle/plan.md from the approved specs
    tackle build                    # implements the plan; freezes .tackle/build.diff
    tackle pr                       # writes the PR body to .tackle/pr.md
    tackle status                   # where the workflow stands

Bug fixes skip specs: `tackle plan --skip-specs "fix the crash"`.
Trivial changes skip to build: `tackle build --trivial "bump the copyright year"`.
`--redo` re-runs a phase (invalidating everything after it); `--fresh` starts over.
If a phase's input is too vague, the agent writes questions to
`.tackle/<phase>-questions.md` instead of guessing — answer them in place and re-run.
Gate budgets (`deterministicRetries`, `reviewLoopIterations`, `circuitBreakerThreshold`)
are config in `.tackle/config.json`, not constants.

Status: workflow spine landed (specs → plan → build → pr), phase-gated and resumable.
