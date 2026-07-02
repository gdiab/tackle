# Tackle: a bespoke agentic dev harness

A PRD / architecture doc for **Tackle**, a personal agentic software-development harness, written so it can also seed a blog post. The name carries the thesis: tackle is the rigging and gear that does the work, and "tackle the problem" is the verb. The harness is the durable kit; the runtime is the engine you clip into it. The thesis it's built on, borrowed from Miller's "stop building agents, harness Goose" piece: the agent runtime is becoming a commodity, and the harness wrapped around it is the thing worth owning. This doc commits to building that harness, names what it borrows from the systems already studied, and stays deliberately uncommitted on the one decision that doesn't need making yet.

## The bet

Most "AI dev team" repos pick a runtime and marry it. bdfinst/agentic-dev-team is the sharpest example: a genuinely sophisticated phase-gated team, with evals and mutation gates and cost telemetry, all of it welded to Claude Code's plugin, agent, and hook systems. Study it and the same lesson keeps surfacing. The orchestration, the gates, the evals, the self-knowledge are the durable part. The runtime underneath is replaceable, and pretending otherwise is how you end up rewriting everything when the model or the pricing or the tool changes.

So the bet here is to build the durable part as the product, and treat the runtime as a slot. Claude Code today, Codex CLI or a local model tomorrow, without rewriting the workflow that sits on top.

There's a second bet underneath the first, and it's the one driving the architecture more than any taste preference: this should run on a subscription, not on metered API credits. A harness that calls the raw API bills me per token forever. A harness that drives the interactive agent CLIs I already pay for rides quota I've already bought. That single constraint kills the "build my own loop over the Claude API" option before it starts, and it's worth being honest that cost, not elegance, is what kills it.

Research sharpened this from a preference into a mechanic, and it moved the default substrate. The thing that decides subscription-vs-metered billing isn't interactive-vs-headless mode, it's which credential sits in the harness's environment: any `ANTHROPIC_API_KEY` silently flips a turn to metered billing, in `-p` mode with no prompt at all, which is almost certainly the real source of the "`claude -p` charged me outside my plan" reports. The official `claude` binary on an OAuth token rides the subscription and is the documented, permitted path for individual use. What's actually banned, and enforced since January 2026, is lifting your OAuth token into a non-Anthropic client. But Anthropic also announced a June 2026 change to move `claude -p` and the Agent SDK off subscription limits onto metered credits, paused it on launch day under pushback, and called it "revising," not "cancelled." So the Claude subscription path works today but sits on a policy clock I don't control. Codex's posture toward plan-driven CLI use is materially more permissive, with no equivalent announced re-metering, so the default author substrate leans Codex, while the adapter line keeps Claude Code and the rest as first-class slots. The bet is on subscription economics; Codex is currently the most durable way to hold it.

## Goals and non-goals

**Goals**

- One harness I actually use daily across my real stacks: JS/TS, Python, and iOS/Swift.
- Runtime-portable: the workflow, agents, skills, and gates are defined once, runtime-neutral, and a thin adapter binds them to whatever backend runs the turn.
- Subscription-first economics: prefer execution paths that ride a plan I already pay for over per-token API billing.
- Self-improving on contact with a new stack: when it meets a language or framework it doesn't know well, it researches the idioms and generates its own stack profile, quality rules, and build/test wiring, then validates them before trusting them.
- TDD and review as control flow, not advice, the way Superpowers makes its workflow mandatory rather than suggested.
- Cross-model review by default: the model that reviews a change is never the model that wrote it, because self-review shares its own blind spots.
- Honest self-measurement: it knows what it costs, where it's flaky, and where it regressed, borrowing the evals apparatus from bdfinst/agentic-dev-team.

**Non-goals**

- Not a product for other people. No marketplace, no multi-tenant concerns, no onboarding flow. Solo tool.
- Not a from-scratch agent runtime. I am not rebuilding the agent loop, context management, or tool execution that Claude Code and Codex already give me. Goose exists if I ever want a vendor-neutral engine; I don't need to write one.
- Not stack-exhaustive on day one. It earns new stacks through the self-improvement loop, not through me hand-authoring profiles for languages I don't use.

## Core design principles

1. **The runtime is a slot, not a foundation.** Everything above the adapter line is runtime-neutral. This is the lesson bdfinst/agentic-dev-team teaches by counterexample: it's excellent and almost entirely unportable.
2. **Gates are code, not vibes.** A commit that hasn't passed review doesn't happen. A test that wasn't written first isn't a passing test. bdfinst enforces this with hooks; the principle survives even if the enforcement mechanism changes per runtime.
3. **Subscription before API, enforced as a gate.** When two execution paths produce the same result, take the one that doesn't bill credits. This is mechanical, not aspirational: the credential in the process environment decides billing, so an adapter that claims a subscription path must guarantee `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset, authenticate on an OAuth token, and assert the active billing type before it trusts a turn. A stray key in the env is a silent metered-billing bug, not a warning.
4. **The harness improves itself.** New stack, new failure mode, new repeated correction: the system's response is to generate or modify a skill, validate it, and keep it. This is the feature that makes it mine rather than a fork of someone's.
5. **Selective context beats more context.** Targeted test maps over dumping the suite (TDAD), findings written to files, not held in the window (bdfinst).
6. **Measure or it didn't happen.** Cost, variance, regressions, and friction are recorded. Claims about the harness's quality are backed by fixtures, not faith.

## Architecture

### The adapter line

The whole design hinges on one boundary. Above it: runtime-neutral specs. Below it: a small contract every backend implements.

```
runtime-neutral specs
  agents/        persona + effort band + allowed tools (no model names)
  skills/        triggered workflows, slash-style entry points
  gates/         declarative: when X, require Y to pass
  workflow/      the phase spine (specs -> plan -> build -> pr)
  knowledge/     CONTEXT.md, ADRs, stack profiles
  evals/         fixtures + expected, the self-measurement layer
------------------------------- adapter line -------------------------------
  adapter contract:  run(prompt, tools, workdir, effort) -> structured result
  adapters:
    codex-cli      default author; drives Codex CLI; rides plan; permissive programmatic use
    claude-code    drives `claude` CLI; rides subscription; native hooks/skills; default reviewer
    local          ollama / llama.cpp for cheap or offline turns
    api (fallback)  raw Claude/other API when only metered access works
```

The adapter does three jobs: translate a runtime-neutral agent/skill spec into whatever the backend expects, run the turn, and normalize the result back into a structured object the orchestrator can grade. Where a backend has native primitives that match a concept (Claude Code hooks for gates, Claude Code skills for skills), the adapter maps onto them instead of reimplementing. Where it doesn't (a local model has no hook system), the adapter enforces the gate in the orchestration layer itself.

`[G: this is me committing to the hybrid you wouldn't pick in the poll. The substrate isn't chosen because it's abstracted. Codex is now the default author adapter, on the subscription-durability argument, not because I like it more; Claude Code is the default cross-model reviewer and stays first-class. The contract is narrow enough that local and API are realistic follow-ons, not fantasies. If this abstraction starts costing more than it saves, collapse it to Codex-plus-Claude and move on.]`

### Subscription economics, concretely

This is the constraint the whole substrate decision turns on, so it's worth stating as a mechanic rather than a vibe. Billing is decided by credential precedence in the process environment, not by which mode you run. The durable-to-fragile ranking the research produced:

- **Most durable: drive the interactive vendor CLI from outside** (pty or tmux, normalized to a blocking call). This is the path that survives re-metering, because the official interactive CLI on an OAuth session keeps drawing from subscription limits even under the change Anthropic proposed. The `tmuxlet` project demonstrates exactly this for Claude.
- **Currently fine, but named in the paused change: headless `claude -p`** on a `CLAUDE_CODE_OAUTH_TOKEN` (the 1-year token from `claude setup-token`, built for CI), with every API-key env var unset.
- **Blessed but most threatened: the Agent SDK / ACP path** (`@agentclientprotocol/claude-agent-acp`, the sanctioned successor to the OAuth-token approach Anthropic blocked in January 2026). It uses the official SDK, so it's permitted, but it's precisely what the June 2026 re-metering targeted. This tier has a notable consumer: Goose rides Claude subscriptions through ACP, which makes a third-party engine subscription-backed today — at exactly this tier's fragility, and for the Claude side only.
- **Banned: token extraction into a non-Anthropic client.** Don't.

Codex carries no equivalent announced re-metering today, which is why it's the default author. The Claude adapter is therefore built as an interactive-CLI driver first, with `-p` as the headless fallback, so the subscription path is the most durable flavor available rather than the most convenient one.

One honest caveat on the bet itself: subscription-first only wins at volume. The captured Goose research includes the opposite migration — people leaving the $200/mo Claude plan for Goose on the metered Claude API and landing around $30/mo — because at light usage, metered is cheaper. The bet holds for a harness that runs many turns daily across multiple repos, which is the intended use; if actual usage turns out light, the cost telemetry (which records `billing_type` per turn anyway) should be allowed to falsify the bet rather than the bet being treated as identity.

### Pi as the substrate candidate

Pi (pi.dev, "a minimal agent harness. Adapt Pi to your workflows, not the other way around") changes the calculus for the adapter line. It's built for exactly the portability wanted: 15+ providers and hundreds of models, four operating modes (interactive TUI, print/JSON, RPC, and SDK embedding), TypeScript extensibility for custom tools and commands, and `AGENTS.md`-style project instructions. Its pitch is that "features that other agents bake in, you can build yourself."

That makes Pi a real candidate to *be* the runtime-neutral core rather than just sit behind an adapter. The RPC and SDK-embedding modes mean the orchestrator could drive Pi as the engine and inherit multi-provider routing instead of building it. The honest catch is the subscription-vs-credits constraint: Pi routes through provider API keys, so by itself it bills metered credits, which is the exact cost model this whole bet is trying to avoid. So the likely shape is complementary, not either-or. Pi is the extensibility and multi-provider layer; the Claude Code and Codex CLI adapters are the subscription-economics layer. The open design question is whether Pi sits *under* the adapter line as the core, or *as* one more adapter alongside Claude Code.

`[G: research confirmed the worry: Pi routes through provider API keys, so as a core it bills metered for every turn, which is the exact model the whole bet rejects. That demotes it. Pi stays an adapter, or the multi-provider layer, unless I can make it shell out to the subscription-backed CLIs (drive the `claude`/`codex` binary as a Pi tool) rather than calling provider APIs directly. Prototype that shell-out in Phase 3; if it can't, Pi is a metered-only adapter and never the core.]`

### Sandcastle as prior art for the adapter line

The adapter contract has near-exact prior art that the first draft of this spec missed: `@ai-hero/sandcastle` (TypeScript, MIT, ~5k stars) already ships a provider-agnostic `AgentProvider` contract across Claude Code, Codex, Cursor, OpenCode, Pi, and Copilot, crossed with Docker/Podman/Vercel/no-sandbox isolation. Its contract shape — non-interactive run mode, auto-approval flag, model selection, env-based auth, line-delimited JSON stream events, resume by session ID with filesystem-backed storage — is essentially `run() -> TurnResult` built by someone else first. It also documents the concrete mechanics this spec asserted without specifying: how a Codex adapter actually rides the subscription (mount `~/.codex` into the sandbox, or run unsandboxed on the local login), and a worked secrets-hygiene design (env not captured by the scaffold).

The decision is deliberately *evaluate first*, not adopt or reject: Phase 0 opens with a short spike reading Sandcastle's `AgentProvider` contract and its Codex driver, then chooses between building on it, writing own adapters that crib the proven contract details, or rejecting it with a stated reason. Adopting it wholesale trades adapter work for a dependency on their release cadence; ignoring it means re-deriving stream-event and session-resume details they've already debugged. Either way the spike is cheap and the contract comparison keeps `TurnResult` honest.

`[G: mildly embarrassing that two research passes missed the one project that already built the adapter line. The spike is the honest response: if Sandcastle's contract is good, TurnResult should look like it or be it.]`

### Model and effort routing

Agents declare an effort band, never a model, exactly as bdfinst/agentic-dev-team does it (`effort: low | medium | high`). A routing table resolves band plus backend to a concrete model. The same `high`-effort security review can resolve to Opus on the Claude Code adapter, to a Codex model on that adapter, or to the largest local model offline. Routing is also where the subscription-first rule lives: prefer the subscription-backed adapter for a given band, fall back to API only when forced. With no routing table configured, behavior is the shipped default and nothing surprising happens, which is the invariant bdfinst pins as a test.

### The workflow spine

Borrowed wholesale from bdfinst/agentic-dev-team because it's the right shape and doesn't need reinventing: `specs -> plan -> build -> pr`, with a human gate between phases and each phase writing its output to a file rather than carrying it in context. Bug fixes skip specs. Trivial changes skip to build. The plan is the primary review artifact, since reviewing 200 lines of plan is cheaper than reviewing 2,000 lines of code.

Superpowers contributes the insistence that the flow is mandatory: brainstorm before building, plan before coding, test before implementation, review before done. The dynamic-workflows-in-Claude-Code source contributes the escape hatch: for tasks that don't fit the fixed spine, the orchestrator can compose a workflow on the fly rather than forcing every job through the same pipe. That source catalogs six patterns (classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, loop-until-done), and flags two operational caveats that land in Phase 4: dynamic workflows can burn significantly more tokens, and the composition step wants the strongest available model. So the escape hatch earns its place only when the fixed spine handles a task badly, never as a default. One coupling to be honest about: dynamic workflows as documented are a Claude Code capability (keyword-triggered, gated to the strongest Claude models), which sits awkwardly with a Codex-default author — in practice the escape hatch may only exist on the reviewer runtime until the orchestrator can compose workflows itself. Ghuntley's Ralph loop sharpens the loop-until-done case specifically: the loop is a determinism container (fresh context reloaded each cycle), which is exactly the shape of the unattended opt-in mode.

### Gates

Declarative, runtime-neutral, enforced by whatever the adapter has. Each gate is a measurement emitting a status; the failure-handling policy lives in "Runtime mechanics / Gate semantics," not in the gate. The starting set:

- **Pre-commit review.** No commit until a review pass matches the staged hash. bdfinst's `.review-passed` mechanism is the model.
- **Test-first, gated on a dependency map.** Build steps that add code without a failing test first get rejected, but only once a source-to-test dependency map exists for the repo. This caveat is load-bearing, not pedantic: TDAD (test-driven agentic development research) measured that generic "write a failing test first" instructions *without* targeted test context pushed regressions to 9.94%, worse than the 6.08% no-TDD baseline, while the dependency map dropped them to 1.82%. (Provenance hedge: those numbers were captured from the paper's abstract, not a full read; the note that holds them says so itself. Since the gate's whole advisory-vs-blocking design leans on them, verifying against the full paper is a named Phase 0 task, not an eventually.) A blocking gate that makes outcomes worse is negative value, so the rule is advisory-only until the map exists and blocking once it does. The map is the "lightweight agent skill / static text file queried at runtime" that TDAD describes: its *builder* is stack-specific and ships in the stack profile, the *map itself* is built and cached per repo from the import graph plus coverage data. The JS/TS map-builder is a named Phase 0 deliverable, not a Phase 2 nicety, precisely so the test-first gate never ships in its harmful form.
- **Structural review.** The review gate adopts the Cursor `thermo-nuclear-code-quality-review` skill's posture: block on missed simplifications and file-size explosions, not just on correctness. It asks whether the change could be reframed so whole branches disappear, and treats a file crossing ~1k lines as a signal, not a shrug.
- **Mutation survival** where tooling exists (the honest caveat: it won't exist for Swift, see open questions).
- **Destructive-command guard.** No `rm -rf`, no force-push, without an explicit override.

### Cross-model review as a first-class gate

The single most useful review pattern landed on in practice: write the code with one model, review it with a different one. This was first found with Claude writing and Codex reviewing, where the Codex pass reliably caught things the Claude pass missed. The gate is direction-agnostic, so with Codex now the default author, the default review flips to Claude; what matters is that author and reviewer are never the same runtime. The likely reason it works in either direction is that a model reviewing its own output shares its own blind spots. The same priors that produced the code also rationalize it, so self-review converges on "looks fine" too easily. A different model doesn't share those priors and breaks the symmetry.

Two distinct ideas live here. One is *who reviews*: a different runtime than authored the change. The other is *how review closes*: the loop-until-clean closeout from the autoreview skill, where the reviewer's findings feed back and re-run until the diff comes back clean. They are independent and both worth having. The model-switch breaks the blind-spot symmetry; the closeout loop is what stops a single review pass from rubber-stamping.

The multi-runtime architecture turns the model-switch from a manual habit into a gate. Because the reviewer is just another adapter call, the review gate can require that the reviewing runtime differs from the authoring runtime. Concretely:

- The `build` phase records which adapter and model authored each change (the authorship record, specified under "Runtime mechanics"). The gate reads it and refuses to close if author and reviewer are the same runtime, failing closed on unknown authorship.
- The review gate routes to a *different* adapter and model by policy, not by chance. Author on the Codex adapter, review on the Claude Code adapter.
- The reviewer sees the frozen diff plus the spec only, never the author's plan or transcript (the isolation rule, specified under "Runtime mechanics / Cross-model review handoff"). Isolation is the feature, not an oversight.
- This composes with the structural-review posture (the Cursor thermo-nuclear stance) and with the panel idea from the autoreview skill and the LLM Council skill: a cross-model panel is just N reviewers drawn from N different runtimes.

`[G: this is the pattern I most want to be load-bearing. Cheapest, highest-yield review upgrade I've found, and it's basically free given the adapter design already has to call multiple runtimes.]`

### Self-improving stack adaptation

This is the part that makes the harness worth building instead of forking. bdfinst ships eight hand-written `test-stack-profiles/` and zero for Swift, because the author wrote what he ran. This version generates them on demand.

When the harness meets a stack it has no profile for, it runs a stack-onboarding loop:

1. **Detect.** Manifest and file signals (`package.json`, `pyproject.toml`, `*.xcodeproj`, `Package.swift`) identify the stack and its frameworks. This is also where bdfinst's recon blind spot gets fixed: it doesn't detect `.csproj`, `.swift`, or Xcode projects at all.
2. **Harvest, then research.** Before generating anything, it harvests skills that already exist in George's repos. This isn't hypothetical: the Arbatash repo already ships mature SwiftUI skills (`swiftui-animation`, `swiftui-gestures`, `swiftui-layout-components`, `swiftui-patterns`, with a referenced `swiftui-navigation`), all targeting iOS 26 / Swift 6.2 with MV architecture and accessibility baked in. Those get ingested as the Swift starting point rather than reinvented. Only after harvesting does a subagent research what's still missing: test pyramid and runner, lint and format and build and test commands, mutation tooling availability, SAST options, common smells.
3. **Generate.** It writes a candidate stack profile, a quality-review skill tuned to the stack, and the build/test adapter wiring, all in the runtime-neutral format.
4. **Validate.** Before anything generated is trusted, it has to pass a probe: a small fixture in that stack, graded the way bdfinst grades its eval pairs. Generated-but-unvalidated profiles are quarantined, never silently used. This is the guardrail that keeps the self-improvement from confidently making things worse.
5. **Register, with a human gate, advisory until approved.** A profile that passes its probe is still only *advisory*, never blocking, until approved at the human gate. Graduation needs both: the fixture pass and sign-off. A fixture pass alone is not a production pass, so no generated profile blocks a commit on fixture-pass strength. The decision and its rationale land in `decisions.md`.

The same loop generalizes beyond stacks, but the signal it learns from matters enormously, and it's the place this kind of system usually rots. Quality rules evolve only from **traced regressions**, never from raw gate-failure frequency. The carabiner project names the failure mode precisely: if you tune quality rules from gate-failure counts and a meaningful share of those failures are false positives, in six months the profile has encoded hallucinations as institutional knowledge. So a rule changes because a real bug traced back through the authorship record to a specific change, not because a gate fired a lot. This is why the authorship record (specified under "Runtime mechanics") is a dependency of the loop, not just of the cross-model gate: without it a regression cannot be traced to the profile that produced it.

That closes the loop the original spec was missing. A promoted profile is not trusted forever. When a traced regression points back to one, three things happen, the first two automatically: the regression becomes a new fixture (the eval bar grows from real bugs, which also bootstraps a fixture set that otherwise starts empty); the profile auto-demotes from blocking back to advisory (fail-safe: a suspect rule stops enforcing the moment a real bug traces to it, rather than being trusted until noticed); and it surfaces for re-validation, fix, or retirement. Self-improvement that genuinely can't regress silently, because the suspect rule stops blocking on its own and every change still has to clear the same eval bar new code does.

Swift doesn't start from zero thanks to the Arbatash skills, which is lucky, because Swift is otherwise where this loop is weakest. The generated leaves with the least tooling support (mutation testing especially) will surface here first. The Arbatash skills also de-risk the harvest step: they're a real test of whether ingesting existing repo skills produces a usable profile or just noise. (Verification note: the Arbatash skills claim currently rests on this spec's own assertion — the vault's Arbatash note is a stub that lists none of them — so confirming the skills actually exist in that repo is a cheap pre-Phase-2 check.)

The Swift leg also shouldn't harvest from Arbatash alone. The Paul Solt Xcode-skills research catalogs ready-made iOS agent-skill packs (Hudson's, van der Lee's, Ricouard's official Codex "Build iOS Apps" plugin, Zabłocki's rules-plus-loader) and, more importantly, names the precondition that decides whether any of them matter: an agent-friendly build base — warnings-as-errors, a single Makefile-style entry point, xcbeautify, buildable folders — because no skill pack helps an agent that can't build and test the project. The Swift stack profile therefore has two layers: the build-base wiring first, harvested skills second.

`[G: the Swift leg of this is the real test. JS/TS and Python self-onboarding is low-risk and bdfinst already proves the paths work. Swift is where generated profiles will be weakest and where the validate-before-trust loop actually gets tested. Worth pointing the harvest step at Arbatash first as the cleanest available proof.]`

### Self-measurement

Lift the evals and memory apparatus from bdfinst/agentic-dev-team more or less directly, because it's the most sophisticated and most portable thing in that repo:

- **Fixtures plus expected outputs**, graded model-free so evals run cheaply in CI.
- **Flaky-quarantine:** pairs that score in the unreliable middle get isolated and tracked, not deleted and not allowed to block.
- **Fingerprint replay cache:** SHA-256 over the transitive closure of an agent's definition and the files it reads, so unchanged evals replay at zero token cost.
- **A persistent `decisions.md`:** dated, ID'd, with rejected alternatives, surviving session resets.
- **Cost and friction telemetry:** what each run spent, which files churn, which sessions hurt. Format is adopted, not invented: bdfinst's `session-digest.json` plus churn heatmap is the starting shape, and the evals run model-free in CI the way bdfinst runs them, so self-measurement doesn't itself burn quota.

### Shared vocabulary

From mattpocock/skills and the opencode conversations: a `CONTEXT.md` plus ADRs give the agents a domain language so they stop re-explaining the project to themselves every turn. Cheap to maintain, and it cuts the verbosity tax that otherwise scales with every subagent call.

## Runtime mechanics

The architecture above is silent on what actually happens at runtime when a gate fails, a loop runs long, or state moves between phases. That silence is where a design like this usually dies, so this section pins the mechanics down. Most of it is borrowed and cited; where it's invented (the retry and timeout budgets), the numbers are tunable config with the defaults named here, not constants baked into the code.

### The adapter result contract

Every adapter implements `run(prompt, tools, workdir, effort)` and returns one normalized envelope, the `TurnResult`, regardless of backend. This object is the entire interface the orchestrator grades against, so it has to be concrete:

- `status` is a closed enum: `completed | refused | timeout | tool_error | budget_exceeded`. Gate and loop logic branch on this deterministically; there is no parsing of free text to decide what happened.
- `workdir_diff` is the git diff the turn produced, the artifact of record. Phases and reviewers hand off this diff, never a shared context window. Two runtimes with different window limits therefore always review the same bytes.
- `transcript_ref` points at the full transcript on disk. It is not inlined. The only thing carried in-window between turns is a short model-written `summary`.
- `authorship` carries `{adapter, model, effort}` and (for build turns) the stack profile in force. This single field feeds both the cross-model gate and the self-improvement regression trace (see "The authorship record").
- `usage` carries `{tokens, billing_type}`. Because `billing_type` rides in the envelope, the subscription-before-API rule is a field assertion on every turn, not a separate probe: a turn that comes back metered when it should have been subscription is a gate failure.

The adapter's job is to translate a runtime-neutral spec into the backend's dialect, run the turn, and populate this envelope. Where a backend has a native primitive (Claude Code hooks for gates), the adapter maps onto it; where it doesn't (a local model), the adapter fills the same fields from the orchestration layer. The envelope shape is what makes "the runtime is a slot" true in practice rather than in slogan.

### Phase handoff and context budget

Handoff between spine phases is by named markdown progress file, not by passing the context window forward. Borrowed directly: each phase writes its output to `memory/*.md` progress files instead of keeping it in context, and an Orchestrator agent keeps context under a ~40% ceiling by loading selectively (bdfinst). So `/specs` writes `specs.md`, `/plan` writes `plan.md`, `/build` produces the diff plus `build-notes.md`, `/pr` writes the PR body. The handoff unit is the file; its type varies by phase. The diff is specifically the build phase's artifact, not a universal currency, which is why earlier phases pass documents and only the build phase passes a diff. The ~40% selective-load ceiling is also the answer to context budgeting: a phase loads the prior artifacts it needs, not the whole history.

Each phase opens with a clarification precondition: before it executes, it inspects its input artifact, and if that input is too ambiguous or incomplete to act on responsibly, it emits clarifying questions and halts to the human gate instead of proceeding on a guess (the detect-ask-wait shape from the clarification-workflow-pattern). This is not a new phase, it is a cheap precondition that rides the attended-first machinery, and it kills the "built the wrong thing from a vague spec" failure class. The build phase is the most valuable place for it, since that is the expensive cycle to redo.

### Gate semantics

A gate does not encode its own failure behavior. Borrowing bdfinst's worker/policy separation: a gate is a measurement that emits a status, and a single orchestrator policy decides what the status means for control flow (measurement skills emit a status enum; the orchestrator, not the worker, decides whether to halt). That keeps failure handling in one place instead of scattered across every gate.

Gates split into two classes with different policies, the two-layer model from the codacy coding-agents independent-quality-gates approach (deterministic checks enforce, AI checks augment):

- **Deterministic gates** (tests pass, types check, lint, `billing_type == subscription`, destructive-command guard, mutation survival where tooling exists). Pass/fail is unambiguous. On failure: hand the error back to the build phase, retry once, then halt to the human gate. Never silently continue.
- **AI gates** (cross-model review, structural review). Failure means "the reviewer found issues," which is a loop, not a verdict. On failure: feed the findings back, re-run, loop-until-clean (the closeout loop borrowed properly from the autoreview skill), bounded to two iterations, then escalate to the human gate with the unresolved findings.

The hard caps that prevent runaway live in the orchestrator, never in a prompt: a max-iterations-per-phase ceiling, a per-tool timeout, and a circuit breaker that halts on a repeated identical error signature. The defaults (1 deterministic retry, 2 review-loop iterations, circuit-break on the second identical error) are config, not constants. A flaky measurement that scores in the unreliable middle goes to quarantine, kept visible but excluded from blocking, rather than forcing a halt.

The harness is attended-first: the spine's human gate between phases is the default, and unattended loop-until-done is an explicit opt-in mode for well-scoped tasks, not the baseline. When any retry or loop budget is exhausted, the orchestrator emits a "needs human decision" event carrying the artifact (the diff, the clarifying questions, or the failing gate's findings), and the default presenter is a blocking terminal prompt. The presenter is abstracted so an adapter can later route that event to a notification or an editor, but v1 is stdout because you are present.

### Cross-model review handoff

When the review gate routes to a different runtime than authored the change, the reviewer receives the frozen build diff plus the spec / acceptance criteria, and nothing else. It reviews outcome against requirement with fresh eyes, the way the autoreview skill's frozen-bundle panel and Galley's review-against-acceptance-criteria both work. The author's plan and transcript are deliberately withheld: handing the reviewer the author's reasoning re-imports the blind spots the model-switch was meant to escape, and plan-conformance is the human gate's job at plan-approval, not the reviewer's. Because the handoff is files, not a window, reviewer and author can have different context limits and still review identical bytes.

### The authorship record

The build phase records, per change, which adapter and model and stack profile produced it, using the `agent_id{tool, id, model}`-plus-line-range record shape proven by the carabiner attribution tool. Unlike carabiner, which reverse-engineers this after the fact from git history, the harness emits it actively at build time because it owns the runtime slot and already knows the answer. The record is fail-closed: if a hunk's authorship can't be established, it is marked unknown and the cross-model gate treats unknown authorship as a failure rather than guessing. One record, two consumers: the cross-model gate reads it to enforce reviewer-runtime != author-runtime, and the self-improvement loop reads it to trace a later regression back to the profile that caused it.

### What Tackle itself is

The spec was silent on this until a gap review caught it: everything above describes what the harness *does*, and nothing said what it *is*. Pinned now:

- **A TypeScript CLI.** It matches the primary daily stack, it's the strongest ecosystem for driving other CLIs and ptys, and the closest prior art (Sandcastle) is TypeScript, so the adopt-or-borrow decision stays cheap in either direction. Plain CLI invoked per phase (`tackle specs`, `tackle plan`, `tackle build`, `tackle pr`), not a daemon — the attended-first model means there's a human at a terminal, and a resident process earns nothing until unattended mode matters.
- **State is files on disk, in the target repo.** The progress files (`specs.md`, `plan.md`, `build-notes.md`), the authorship record, `decisions.md`, and gate statuses live in a `.tackle/` directory in the repo being worked on; the harness's own config, routing table, stack profiles, and evals live in the harness repo. No database. Files are the state model because they're already the handoff model.
- **Crash recovery is resume-from-artifacts.** Because every phase writes its output to a file and the diff is the artifact of record, a killed run resumes by re-reading `.tackle/` state rather than replaying a transcript. Adapters that support native session resume (Codex `exec resume`, Sandcastle-style session IDs) can additionally resume a *turn*; the orchestrator only promises to resume a *phase*. A turn that dies mid-flight reruns from the last completed artifact.
- **Concurrency: serial by design in v1.** One agent, one repo, one phase at a time. When parallel agents arrive (fan-out review panels are the likely first case), each gets its own git worktree — the already-proven isolation pattern — never a shared working directory. Stating this now so the serial assumption is a decision, not an accident.

### Security posture

The gap review's sharpest finding: the only guard in the first draft was the destructive-command gate, and the corpus it borrowed from says plainly that a git worktree is not a security boundary and that the realistic threat for an agent harness is prompt injection, not rogue `rm`. The posture, layered by mode:

- **Attended mode (the default) trusts the human gate.** The operator sees every phase transition and approves plans and commits; the destructive-command guard and the billing assertion are the mechanical backstops. This is the same trust model as running the vendor CLIs by hand, which is what it wraps.
- **Unattended mode (the Ralph-loop opt-in) requires a sandbox, full stop.** An unattended agent reading untrusted input (issues, web content, dependency code) with write access and no human gate is the prompt-injection kill zone. The unattended flag refuses to run outside a container/VM boundary (the Sandcastle Docker/Podman pattern) with a scoped credential set. This is a gate like any other: mechanical, not advisory.
- **Secrets follow the billing rule's shape, generalized.** The adapter environment is allowlist-built per adapter — the Codex adapter gets its `~/.codex` auth, the Claude adapter its OAuth token, and neither gets the other's credentials or the operator's full env. The `ANTHROPIC_API_KEY`-must-be-unset billing gate already forced per-adapter env construction; secrets hygiene is the same mechanism doing its second job.

## What it borrows, and from where

| Source | What it contributes |
|---|---|
| bdfinst/agentic-dev-team (harness review) | The phase spine, hook-as-gate pattern, the whole evals/memory/routing apparatus, effort bands |
| Miller, "stop building agents, harness Goose" | The core thesis: harness is the moat, runtime is commodity |
| Obra Superpowers | Mandatory skill-triggered workflows over optional suggestions |
| mattpocock/skills | Small hackable skills, `CONTEXT.md` + ADRs as shared vocabulary |
| Anthropic, dynamic workflows in Claude Code | On-the-fly workflow composition as the escape hatch from the fixed spine |
| TDAD (test-driven agentic development) | The source-to-test dependency map that makes test-first help (1.82% regressions) instead of harm (9.94% without it); it gates the test-first rule |
| Cursor `thermo-nuclear-code-quality-review` | Review gate that blocks on missed simplification, not just correctness |
| Goose | The fallback vendor-neutral engine if a local/multi-provider engine is ever wanted; multi-provider proof; rides Claude subscriptions via ACP, making it a candidate subscription-backed adapter, not only a metered one |
| mcporter | MCP servers as the runtime-independent tool layer |
| autoreview skill / LLM Council skill | The loop-until-clean closeout (distinct from the model-switch) and the frozen-bundle isolated panel; multi-agent panels against single-model overconfidence |
| Pi (pi.dev) | Minimal, aggressively extensible multi-provider harness; demoted from core candidate to adapter once research confirmed it bills metered per turn |
| Arbatash repo SwiftUI skills | Real iOS 26 / Swift 6.2 skills to seed the Swift stack profile and prove the harvest step |
| codex plugin (cross-model review) | Author with one model, review with another; the highest-yield review upgrade, promoted to a gate |
| tmuxlet | Drives the interactive vendor CLI from outside, normalized to a blocking call, to stay on the subscription bucket; the durable subscription-driving mechanism, demonstrated |
| OMK (open-multi-agent-kit) | Provider-neutral control plane: routes runtimes, scopes MCP, runs DAG workers, verifies evidence before completion; the adapter line plus gates, already built |
| San | Runs Claude Code skills/plugins/MCP unmodified on a swapped runtime; proves the portability thesis and de-risks the skills investment |
| Loki Mode | Blind-review completion council that can veto "done"; a stronger completion gate than the vendor CLIs ship, matches the cross-model review stance |
| claude-agent-acp / ACP | Zed's official-SDK ACP adapter; the sanctioned (but re-metering-threatened) successor to the blocked token-extraction path; the mechanism Goose uses to ride Claude subscriptions |
| codacy coding-agents independent-quality-gates | The two-layer gate model: deterministic checks enforce, AI checks augment |
| deterministic-agent-loop-control | Hard loop control (iteration caps, per-tool timeouts, circuit breakers) belongs in the orchestrator, never the prompt |
| clarification-workflow-pattern | The detect-ambiguity / ask / wait precondition that fronts each phase |
| ghuntley Ralph loop | Loop-until-done as a determinism container (fresh context each cycle); the shape of the unattended opt-in mode |
| carabiner (attribution tool) | The active authorship record (`agent_id{tool,id,model}` + line ranges, fail-closed) and the false-positive-contamination guard on self-improvement |
| Galley | Review against acceptance criteria with on-disk run evidence; the rigor target if the markdown progress files prove too loose |
| Sandcastle (`@ai-hero/sandcastle`) | Near-exact prior art for the adapter contract (provider-agnostic run/resume/stream/auth across six runtimes × four sandboxes); the Codex subscription-auth mechanics; the worktree-is-not-a-security-boundary and prompt-injection warnings; Phase 0 evaluates adopt vs borrow-the-shape vs reject |
| Paul Solt Xcode-skills research | The iOS agent-friendly build base (warnings-as-errors, single entry point, xcbeautify) as the precondition for any Swift skill pack, plus the catalog of existing iOS skill packs to harvest alongside Arbatash |
| Stripe Minions (Alistair Gray talk) | Real-world proof of the thesis at scale: Stripe forked Goose over 30M LOC with custom tools and an MCP registry; independently converged on the same two-round bounded-retry cap |

## Open questions

- **Where the substrate finally lands.** Leaning resolved: Codex is the default author adapter, on the subscription-durability argument, with Claude Code as the default reviewer. The flip the adapter line was built to allow has happened once already. Still genuinely open is whether Codex's latitude holds, since this is a posture that can change with one pricing announcement; the adapter line stays so the default can flip again without a rewrite.
- **Subscription path on a policy clock.** Anthropic announced moving `claude -p` and the Agent SDK off subscription limits onto metered credits in June 2026, paused it on launch day, and called it "revising." The harness should assume re-metering eventually lands and design the Claude adapter so it degrades from interactive-CLI driving to `-p` to metered API without re-architecting. Open: how aggressively to invest in the Claude subscription path given it's the one most likely to get priced out.
- **Pi's role: core or adapter?** Resolved toward adapter. Research confirmed Pi routes through provider API keys and bills metered per turn, which rules it out as the runtime-neutral core under the subscription-first bet. The only path back to core is making Pi shell out to the subscription-backed CLIs as tools rather than calling provider APIs; that's a Phase 3 prototype, not an assumption.
- **Swift mutation testing.** No off-the-shelf tool exists. Either the mutation gate is JS/TS and Python only, or the self-improvement loop has to generate a minimal Swift mutation harness, which is genuinely hard and maybe out of scope for v1. The Arbatash skills cover authoring quality, not mutation coverage, so this gap stands.
- **Goose as an adapter vs. as a non-goal.** Upgraded from "someday local-model engine": Goose consumes the ACP path to ride Claude subscriptions, so it's a possible *subscription-backed multi-provider adapter* today, not just a metered fallback. That's one durability tier below driving the CLIs directly (ACP is precisely what the June 2026 re-metering targeted), and it covers only the Claude side — nothing equivalent rides a ChatGPT/Codex plan through Goose. It also reframes the Phase 3 Pi question: speaking ACP is an alternative to the shell-out-to-CLIs prototype for making a third-party engine subscription-backed. Still open: whether an ACP-tier adapter is worth building when the CLI-driving tier is strictly more durable.
- **Sandcastle: dependency or reference?** Resolved 2026-07-02 by the Phase 0 spike (`docs/spikes/2026-07-02-sandcastle.md`, decision D-002): **borrow the shape**. Three structural mismatches rule out building on it — its auth model mandates API keys and wontfixed subscription-in-sandbox, its `noSandbox()` mode (the one Tackle v1 would use) bypasses the env allowlist that secrets hygiene needs, and its throw/completion-signal result shape maps lossily onto the closed `status` enum. Tackle's adapters are written fresh on Sandcastle's provider decomposition (command builder + line parser + session storage + usage parser), stealing its CLI recipes, session-resume semantics, and usage normalization verbatim; the repo stays the reference to diff against when CLI flags drift.

## Phased build roadmap

- **Phase 0: Skeleton on one adapter.** Codex adapter only, as the default author substrate. The spine (`specs -> plan -> build -> pr`), pre-commit review gate, one stack (JS/TS). Prove the runtime-neutral specs actually drive a real turn. Phase 0 opens with the Sandcastle spike (evaluate its `AgentProvider` contract before committing to `TurnResult`) and carries two verification chores named elsewhere in this spec: read the full TDAD paper to confirm the regression numbers the test-first gate leans on, and confirm the Arbatash SwiftUI skills actually exist as described. The honest tradeoff of leading with Codex instead of Claude Code: Claude Code's native hooks and skills would have made the gates nearly free, so on Codex the gates get enforced in the orchestration layer from day one. That's more work up front, but it's the work the adapter line was supposed to force anyway, so it surfaces early instead of hiding behind one runtime's conveniences. Smallest thing that does useful work.
- **Phase 1: Self-measurement, plus a throwaway portability spike.** Fixtures, model-free grading, flaky-quarantine, replay cache, `decisions.md`. The harness starts knowing itself. This phase also runs a deliberately disposable spike: port one spec to a second adapter (a local or API backend) just far enough to prove the `TurnResult` contract actually normalizes, even though that adapter doesn't ship until Phase 3. The point is to find a contract flaw now, while it's cheap, instead of discovering at Phase 3 that three phases of work assumed an abstraction that doesn't port.
- **Phase 2: Self-improving stacks.** The onboarding loop, starting with the harvest step pointed at Arbatash to seed Swift. Prove it on Python (low-risk), then on Swift (the real test, but with a real head-start).
- **Phase 3: Second adapter and cross-model review.** Stand up the Claude Code adapter as the default reviewer, which unlocks cross-model review as a real gate (author on Codex, review on Claude). Also the moment to prototype Pi shelling out to the subscription CLIs, to test whether it can ever be the core rather than a metered adapter — with ACP as the comparison approach, since Goose proves a third-party engine can ride Claude subscriptions that way (one durability tier lower, Claude-only). This is where the adapter line earns its keep or gets collapsed. The honest exit criterion: if porting to a second backend is more pain than value, drop the abstraction and stay on Codex. A primitive cross-model pass is available before this via the existing codex plugin, so the value can be felt before the full adapter exists.
- **Phase 4: Dynamic workflows.** The on-the-fly composition escape hatch for tasks the fixed spine handles badly.

## Name and namespace

The project is **Tackle**. The name cleared the one test that actually disqualifies an open-source name: no notable tool already lives in the agentic-coding-harness lane under it. That test is what killed the stronger-sounding metaphors. Spine collides with Spine AI (a YC-backed agent-orchestration product already wired into Claude Code via MCP) and the Esoteric Software game tool. Carabiner is already a coding-agent harness by another author, plus a security-tooling company. Trellis is a current 11.2k-star agent harness (`mindfold-ai/Trellis`). Armature, picked first, turned out to have three live 2026 entrants in exactly this lane, including a PyPI `armature-harness` package billed as "the invisible skeleton that shapes agent output." Tackle is clean where it counts.

Namespace plan, deliberately minimal because this is a solo tool:

- **Repo:** `github.com/gdiab/tackle`, under George's personal account. No org. An org earns its keep only with multiple maintainers or a cluster of related repos, neither of which applies; the global `tackle` user-squatter is irrelevant to a repo under a personal account.
- **Packages, deferred until something actually publishes.** Bare `tackle` is occupied on npm (dead) and is an active code-generation DSL on PyPI, so the published name would be `tackle-harness` or a scope. crates.io `tackle` is free if it ever ships as a Rust crate. None of this needs deciding before distribution.
- **Domain:** optional, deferred. `tackle.dev` and `tackle.sh` appear registrable if a marketing site is ever wanted.

## Blog angle

The post writes itself out of the tension in the research: everyone ships an "AI dev team," almost nobody ships a portable one, and the reason is that the runtime is the easy 80% and the harness is the hard 20% that nobody wants to abstract. Working title direction: something about the harness being the part you own and the runtime being the part you rent. The self-improving-stack loop is the concrete hook that keeps it from being another think-piece, because it's a real mechanism with a real failure mode (generated profiles that confidently degrade quality) and a real guardrail (validate before trust). Draft when the Phase 2 loop has actually run against Swift, so the post has a scar instead of a hypothesis.

## Update log

- 2026-07-02 (later): Folded in the Goose–ACP connection (from George): Goose rides Claude subscriptions via ACP, so the Goose open question upgrades from "someday local-model engine" to "candidate subscription-backed multi-provider adapter" — at ACP-tier fragility (the re-metering target), Claude-side only. Durability ranking, borrow table (Goose, claude-agent-acp rows), Goose open question, and the Phase 3 Pi prototype (ACP as the comparison approach to CLI shell-out) updated.
- 2026-07-02: Second grounded gap review, patched in place. Pinned **what Tackle itself is** (TypeScript CLI, per-phase invocation, `.tackle/` files-on-disk state, resume-from-artifacts crash recovery, serial-v1 with worktree-per-agent when parallelism arrives). Added a **security posture** section (attended mode trusts the human gate; unattended mode mechanically requires a sandbox against prompt injection; per-adapter allowlisted env doubles as secrets hygiene). Added **Sandcastle** as prior art for the adapter line with an evaluate-first Phase 0 spike, plus its Codex subscription-auth mechanics. Reconciled the subscription bet against the Goose $30/mo counter-datapoint (the bet holds at volume; telemetry may falsify it). Hedged the TDAD numbers as abstract-sourced (full-paper read is a Phase 0 chore) and flagged the Arbatash skills claim for verification. Noted the dynamic-workflows escape hatch is runtime-coupled to Claude Code. Adopted bdfinst's `session-digest.json` telemetry format and CI-run evals. Borrow table gained Sandcastle, Paul Solt Xcode-skills, Stripe Minions.
- 2026-06-25: Created. Synthesized from the bdfinst/agentic-dev-team review plus a sub-agent distillation of captured inspirations (Goose, Superpowers, Pocock, Ralph loop, opencode, dynamic workflows, TDAD, mcporter). Substrate left deliberately abstracted per the portability + subscription-cost constraint. Open: "pi" identity, Swift mutation tooling, final substrate landing.
- 2026-06-25: Folded in three additions: (1) Pi = pi.dev, added as substrate-core candidate; (2) cross-model review (author with one model, review with another) promoted to a first-class gate and a goal; (3) Arbatash repo's SwiftUI skills wired in as the Swift harvest seed. Roadmap, borrow table, goals, and open questions updated.
- 2026-06-29: Closed the runtime-mechanics holes a grounded review surfaced, after a question-by-question grilling pass to settle each decision. Added the **Runtime mechanics** section (adapter `TurnResult` contract; markdown-progress-file phase handoff with the ~40% context ceiling and a per-phase clarification precondition; gate semantics via bdfinst worker/policy separation + codacy two-layer deterministic/AI split + loop-until-clean + orchestrator-level caps as tunable config; attended-first with a stdout human-gate presenter; cross-model review handoff with maximum reviewer isolation; the active fail-closed authorship record). Tied the **test-first gate** to the TDAD dependency map (advisory without it, blocking with it; JS/TS map-builder is now a Phase 0 deliverable) since the source shows the mapless variant *raises* regressions. Separated **cross-model review** (the model-switch) from the **loop-until-clean closeout** and took both. Added **self-improvement** graduation criteria (advisory-until-approved), a regression-feedback loop (traced regression -> new fixture + auto-demote to advisory + surface), and the carabiner false-positive-contamination guard (evolve only from traced regressions). Rounded out the dynamic-workflows borrow (six patterns + token/model caveats). Added a throwaway Phase 1 portability spike. Borrow table gained codacy, deterministic-loop-control, clarification-pattern, ralph-loop, carabiner, Galley.
- 2026-06-27: Named the project **Tackle** and locked it into the spec. Chosen after a sweep of ~18 candidates against npm/PyPI/crates/GitHub/AI-lane; the lead candidates (Spine, Carabiner, Trellis, Keel, Gantry, Armature) all collided with existing in-lane AI tools, with Armature the closest near-miss (a deep lock-in pass found a live PyPI `armature-harness` plus two more 2026 harness products). Namespace kept minimal: repo under `gdiab/tackle`, no org, package/domain decisions deferred to publish time.
- 2026-06-26: Subscription-economics research folded in (three parallel agents: Anthropic billing mechanics, ACP/Goose path, awesome-cli-coding-agents survey). Key shifts: (1) billing is decided by credential precedence in the env, not interactive-vs-`-p`, so the subscription rule became an enforceable gate (no API-key env var, OAuth token, assert billing type); (2) **default author substrate moved from Claude Code to Codex** on the durability argument, after confirming Anthropic announced then paused a June 2026 change to re-meter `claude -p` + Agent SDK; Claude Code becomes the default cross-model reviewer; (3) Claude adapter reframed as interactive-CLI driving first, `-p` fallback, per the durability ranking; (4) Pi demoted from core candidate to adapter (confirmed metered); (5) added "Subscription economics, concretely" subsection and a policy-clock open question; (6) borrow table gained tmuxlet, OMK, San, Loki Mode, claude-agent-acp/ACP; (7) Phase 0 now Codex, Phase 3 stands up Claude Code as reviewer.
- 2026-07-01: Mirrored into the `gdiab/tackle` repo as `SPEC.md` (canonical spec now lives with the code; the vault note at `bespoke-agentic-dev-harness-spec.md` continues as the working/blog-draft copy).
