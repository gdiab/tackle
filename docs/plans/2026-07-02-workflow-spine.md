# Workflow Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phase-gated workflow `specs -> plan -> build -> pr` as four `tackle` commands: each phase runs one adapter turn, writes its artifact to `.tackle/`, passes a deterministic artifact gate, and stops at a blocking human approval prompt — with clarification-instead-of-guessing, resume-from-artifacts, and a `tackle status` view.

**Architecture:** A generic phase runner (`runPhase`) drives any phase from a declarative spine table (artifact path, questions file, prompt inputs, predecessor, entry rules). State is one JSON file (`.tackle/workflow.json`) holding per-phase status plus the authorship record of the last turn. Gates follow SPEC.md's worker/policy split: measurements (turn status, artifact exists, billing type) emit facts; a single policy in the runner decides retry-once-then-halt, with budgets from config, not constants. The human gate is a `Presenter` abstraction whose v1 implementation is a blocking terminal prompt; an unapproved gate is re-presented by the next phase command, which is how a killed run resumes.

**Tech Stack:** Node >= 22, TypeScript (strict, ESM/NodeNext), vitest, commander. No new runtime deps.

**Covers bead:** tackle-atq. Out of scope, with the seams left for them: the pre-commit review gate and AI-gate loop-until-clean (tackle-483 — but `reviewLoopIterations` and `circuitBreakerThreshold` ship in config now so its budgets are already config, and the authorship record it needs is persisted per phase), the dependency-map builder (tackle-5lk), dynamic workflows (Phase 4).

## Global Constraints

- SPEC.md "Phase handoff and context budget": handoff is by named markdown file in `.tackle/`, never by carried context. `specs` writes `specs.md`, `plan` writes `plan.md`, `build` produces the diff plus `build-notes.md`, `pr` writes `pr.md`. A phase's prompt inlines only the prior artifacts its spine entry names (selective load), not the whole history.
- SPEC.md "The workflow spine": human gate between phases; bug fixes skip specs (`tackle plan --skip-specs`), trivial changes skip to build (`tackle build --trivial`); the plan is the primary review artifact.
- SPEC.md "Gate semantics": a gate is a measurement emitting a status; the runner's single policy decides control flow. Deterministic gate failure: retry once, then halt to the human gate — never silently continue. Budgets are config (`.tackle/config.json` over `DEFAULT_POLICY`), not constants. Attended-first: the halt presenter is a blocking stdout prompt behind an abstraction.
- SPEC.md clarification precondition: each phase may emit clarifying questions (`.tackle/<phase>-questions.md`) and halt to the human instead of guessing; answers ride the same file back into the next attempt's prompt.
- Billing is a deterministic gate: a turn that comes back `metered` halts the phase immediately (no retry — a retry would bill metered again).
- The build diff is the artifact of record: frozen to `.tackle/build.diff` at build completion for the future review gate to consume.
- Resume-from-artifacts: a killed run resumes by re-reading `.tackle/` state; re-running a phase command whose artifact awaits approval re-presents the gate, it does not re-run the turn (`--redo` forces a re-run). Re-running a phase invalidates all downstream phase state and artifacts.
- Effort bands `low | medium | high`, never model names; `model` stays an optional override. Default effort `medium`.
- All harness state lives under `.tackle/` in the target workdir. `captureWorkdirDiff` already excludes `.tackle/`, so phase artifacts never pollute the turn diff.
- tsconfig has `strict` and `noUncheckedIndexedAccess`; indexed access must handle `undefined`.
- Commit after every task. Don't mention Claude in commit messages.

## File Structure

```
src/
  cli.ts                    MODIFY: add specs/plan/build/pr/status; share turn options helper
  workflow/
    types.ts                PhaseName, PhaseStatus, TurnRecord, PhaseState, WorkflowState, PolicyConfig
    state.ts                read/write .tackle/workflow.json; loadPolicyConfig (.tackle/config.json)
    artifacts.ts            readArtifact (null if missing/blank), removeArtifact (idempotent)
    spine.ts                PhaseDef table, PHASE_ORDER, BUILD_DIFF_FILE, effectivePredecessor
    presenter.ts            Presenter interface; TerminalPresenter (readline blocking prompt)
    prompts.ts              buildPhasePrompt: per-phase instructions + clarification preamble + inputs
    phase.ts                runPhase: the orchestrator policy (gates, retries, halts, human gate)
test/
  helpers/
    workflow.ts             shared fakes: fakeTurn, scriptedAdapter, presenters, temp dirs
  workflow-state.test.ts    state round-trip, corrupt/versioned errors, config merge, artifacts
  spine.test.ts             table shape, effectivePredecessor across entry points
  presenter.test.ts         TerminalPresenter over PassThrough streams
  prompts.test.ts           per-phase prompt content
  phase.test.ts             deterministic gates: happy path, retries, halt, billing, frozen diff
  phase-resume.test.ts      clarification round-trip, entry/fresh/redo, gate re-present, invalidation
  cli-phases.test.ts        command wiring, flags, exit codes, status output
  spine-e2e.test.ts         full specs->plan->build->pr run + resume-after-rejection
```

## Design decisions pinned here

- **No `tackle approve` command.** The approval prompt fires at the end of the phase command; if declined (or the process dies), the *next* phase command re-presents the pending gate before proceeding. One mechanism serves both the human gate and crash resume. The human can hand-edit an artifact and approve it at that re-presentation without re-running the turn.
- **Clarification detection** is file-based: a completed turn that wrote the questions file but not the artifact means "needs clarification". The human answers by editing the questions file in place and re-running the phase; the prompt then carries the Q&A block. A turn that writes *neither* file is an artifact-gate failure (retry, then halt).
- **Phase statuses** are `needs_clarification | awaiting_approval | approved | halted`. There is no `pending` in the file — an absent phase entry means not started. `halted` records the failed turn for `tackle status` and is re-runnable.
- **Exit codes:** only an `approved` outcome exits 0 (so `tackle plan && tackle build` chains safely); `rejected`, `needs_clarification`, and `halted` set exit code 1.
- **Amending the request:** passing a request argument to a phase re-run replaces `state.request`. Combined with `--redo` this is the "re-run with a better ask" path.

---

### Task 1: Workflow types, state store, policy config, artifact helpers

**Files:**
- Create: `src/workflow/types.ts`, `src/workflow/state.ts`, `src/workflow/artifacts.ts`
- Test: `test/workflow-state.test.ts`

**Interfaces:**
- Consumes: `Authorship`, `BillingType`, `TurnStatus` from `src/adapter/types.ts` (exists).
- Produces: `PhaseName`, `PhaseStatus`, `TurnRecord`, `PhaseState`, `WorkflowState`, `PolicyConfig`, `DEFAULT_POLICY` (types.ts); `readWorkflowState(workdir): Promise<WorkflowState | null>`, `writeWorkflowState(workdir, state): Promise<void>`, `loadPolicyConfig(workdir): Promise<PolicyConfig>` (state.ts); `readArtifact(workdir, relPath): Promise<string | null>`, `removeArtifact(workdir, relPath): Promise<void>` (artifacts.ts).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/workflow-state.test.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifact, removeArtifact } from "../src/workflow/artifacts.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "../src/workflow/state.js";
import type { WorkflowState } from "../src/workflow/types.js";
import { DEFAULT_POLICY } from "../src/workflow/types.js";

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tackle-wf-"));
}

describe("workflow state", () => {
  it("returns null when no state file exists", async () => {
    expect(await readWorkflowState(await tempWorkdir())).toBeNull();
  });

  it("round-trips workflow state through .tackle/workflow.json", async () => {
    const dir = await tempWorkdir();
    const state: WorkflowState = {
      version: 1,
      request: "add a widget",
      entry: "specs",
      phases: { specs: { status: "approved" } },
    };
    await writeWorkflowState(dir, state);
    expect(await readWorkflowState(dir)).toEqual(state);
  });

  it("throws a readable error on corrupt state", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "workflow.json"), "{not json");
    await expect(readWorkflowState(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an unknown state version", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "workflow.json"), JSON.stringify({ version: 2 }));
    await expect(readWorkflowState(dir)).rejects.toThrow(/version/);
  });
});

describe("policy config", () => {
  it("returns defaults when no config file exists", async () => {
    expect(await loadPolicyConfig(await tempWorkdir())).toEqual(DEFAULT_POLICY);
  });

  it("merges overrides from .tackle/config.json over defaults", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 0 }));
    const policy = await loadPolicyConfig(dir);
    expect(policy.deterministicRetries).toBe(0);
    expect(policy.reviewLoopIterations).toBe(DEFAULT_POLICY.reviewLoopIterations);
  });
});

describe("artifacts", () => {
  it("reads a non-empty artifact", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "# specs\n");
    expect(await readArtifact(dir, ".tackle/specs.md")).toBe("# specs\n");
  });

  it("returns null for a missing artifact", async () => {
    expect(await readArtifact(await tempWorkdir(), ".tackle/specs.md")).toBeNull();
  });

  it("returns null for a whitespace-only artifact", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "  \n\n");
    expect(await readArtifact(dir, ".tackle/specs.md")).toBeNull();
  });

  it("removeArtifact deletes and is idempotent", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "x");
    await removeArtifact(dir, ".tackle/specs.md");
    await removeArtifact(dir, ".tackle/specs.md"); // second call must not throw
    expect(await readArtifact(dir, ".tackle/specs.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/workflow-state.test.ts`
Expected: FAIL — cannot resolve `../src/workflow/state.js` (modules don't exist yet).

- [ ] **Step 3: Implement the modules**

```typescript
// src/workflow/types.ts
import type { Authorship, BillingType, TurnStatus } from "../adapter/types.js";

export type PhaseName = "specs" | "plan" | "build" | "pr";

// Absent from WorkflowState.phases = not started. "halted" = a gate budget was
// exhausted or the billing gate fired; re-runnable, kept for `tackle status`.
export type PhaseStatus = "needs_clarification" | "awaiting_approval" | "approved" | "halted";

export interface TurnRecord {
  status: TurnStatus;
  summary: string;
  authorship: Authorship;
  billingType: BillingType;
  transcriptRef: string;
  sessionId: string | null;
}

export interface PhaseState {
  status: PhaseStatus;
  lastTurn?: TurnRecord;
}

export interface WorkflowState {
  version: 1;
  request: string;
  entry: PhaseName;
  phases: Partial<Record<PhaseName, PhaseState>>;
}

// SPEC.md "Gate semantics": budgets are config, not constants. Only
// deterministicRetries is consumed by the spine; the other two are the review
// gate's budgets (tackle-483), defined here so they are config from day one.
export interface PolicyConfig {
  deterministicRetries: number;
  reviewLoopIterations: number;
  circuitBreakerThreshold: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  deterministicRetries: 1,
  reviewLoopIterations: 2,
  circuitBreakerThreshold: 2,
};
```

```typescript
// src/workflow/state.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyConfig, WorkflowState } from "./types.js";
import { DEFAULT_POLICY } from "./types.js";

const STATE_FILE = ".tackle/workflow.json";
const CONFIG_FILE = ".tackle/config.json";

async function readJsonIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readWorkflowState(workdir: string): Promise<WorkflowState | null> {
  const raw = await readJsonIfExists(join(workdir, STATE_FILE));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${STATE_FILE} is not valid JSON; fix or delete it to reset the workflow`);
  }
  const state = parsed as WorkflowState;
  if (state.version !== 1) throw new Error(`unsupported ${STATE_FILE} version; expected 1`);
  return state;
}

export async function writeWorkflowState(workdir: string, state: WorkflowState): Promise<void> {
  await mkdir(join(workdir, ".tackle"), { recursive: true });
  await writeFile(join(workdir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export async function loadPolicyConfig(workdir: string): Promise<PolicyConfig> {
  const raw = await readJsonIfExists(join(workdir, CONFIG_FILE));
  if (raw === null) return { ...DEFAULT_POLICY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  return { ...DEFAULT_POLICY, ...(parsed as Partial<PolicyConfig>) };
}
```

```typescript
// src/workflow/artifacts.ts
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Read a phase artifact; null means "missing or blank", which gates treat identically. */
export async function readArtifact(workdir: string, relPath: string): Promise<string | null> {
  try {
    const content = await readFile(join(workdir, relPath), "utf8");
    return content.trim().length > 0 ? content : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function removeArtifact(workdir: string, relPath: string): Promise<void> {
  await rm(join(workdir, relPath), { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/workflow-state.test.ts` — Expected: PASS (10 tests).
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/types.ts src/workflow/state.ts src/workflow/artifacts.ts test/workflow-state.test.ts
git commit -m "Add workflow state layer: types, state store, policy config, artifact helpers"
```

---

### Task 2: Spine definitions

**Files:**
- Create: `src/workflow/spine.ts`
- Test: `test/spine.test.ts`

**Interfaces:**
- Consumes: `PhaseName` from `src/workflow/types.ts` (Task 1).
- Produces: `PhaseDef` (`{ name, artifact, questionsFile, inputs, predecessor, entryFlag }`), `SPINE: Record<PhaseName, PhaseDef>`, `PHASE_ORDER: PhaseName[]`, `BUILD_DIFF_FILE = ".tackle/build.diff"`, `effectivePredecessor(phase, entry): PhaseName | null`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/spine.test.ts
import { describe, expect, it } from "vitest";
import { BUILD_DIFF_FILE, effectivePredecessor, PHASE_ORDER, SPINE } from "../src/workflow/spine.js";

describe("spine", () => {
  it("orders the phases specs -> plan -> build -> pr", () => {
    expect(PHASE_ORDER).toEqual(["specs", "plan", "build", "pr"]);
  });

  it("names the SPEC.md artifacts", () => {
    expect(SPINE.specs.artifact).toBe(".tackle/specs.md");
    expect(SPINE.plan.artifact).toBe(".tackle/plan.md");
    expect(SPINE.build.artifact).toBe(".tackle/build-notes.md");
    expect(SPINE.pr.artifact).toBe(".tackle/pr.md");
    expect(BUILD_DIFF_FILE).toBe(".tackle/build.diff");
  });

  it("loads selectively: each phase names only the inputs it needs", () => {
    expect(SPINE.specs.inputs).toEqual([]);
    expect(SPINE.plan.inputs).toEqual(["specs"]);
    expect(SPINE.build.inputs).toEqual(["plan"]);
    expect(SPINE.pr.inputs).toEqual(["specs", "build"]);
  });

  it("computes the effective predecessor from the entry point", () => {
    expect(effectivePredecessor("plan", "specs")).toBe("specs");
    expect(effectivePredecessor("plan", "plan")).toBeNull(); // entered here: no predecessor
    expect(effectivePredecessor("build", "plan")).toBe("plan");
    expect(effectivePredecessor("pr", "build")).toBe("build");
    expect(effectivePredecessor("specs", "specs")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/spine.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/workflow/spine.ts
import type { PhaseName } from "./types.js";

export interface PhaseDef {
  name: PhaseName;
  /** Artifact this phase writes, relative to the workdir. */
  artifact: string;
  /** Clarifying-questions file for this phase, relative to the workdir. */
  questionsFile: string;
  /** Prior-phase artifacts inlined into this phase's prompt (selective load). */
  inputs: PhaseName[];
  /** Phase that must be approved before this one runs, in the full spine. */
  predecessor: PhaseName | null;
  /** CLI flag that lets a workflow start at this phase (null = specs is the default entry). */
  entryFlag: "--skip-specs" | "--trivial" | null;
}

export const PHASE_ORDER: PhaseName[] = ["specs", "plan", "build", "pr"];

export const BUILD_DIFF_FILE = ".tackle/build.diff";

export const SPINE: Record<PhaseName, PhaseDef> = {
  specs: {
    name: "specs",
    artifact: ".tackle/specs.md",
    questionsFile: ".tackle/specs-questions.md",
    inputs: [],
    predecessor: null,
    entryFlag: null,
  },
  plan: {
    name: "plan",
    artifact: ".tackle/plan.md",
    questionsFile: ".tackle/plan-questions.md",
    inputs: ["specs"],
    predecessor: "specs",
    entryFlag: "--skip-specs",
  },
  build: {
    name: "build",
    artifact: ".tackle/build-notes.md",
    questionsFile: ".tackle/build-questions.md",
    inputs: ["plan"],
    predecessor: "plan",
    entryFlag: "--trivial",
  },
  pr: {
    name: "pr",
    artifact: ".tackle/pr.md",
    questionsFile: ".tackle/pr-questions.md",
    inputs: ["specs", "build"],
    predecessor: "build",
    entryFlag: null,
  },
};

/**
 * The predecessor that actually exists in this workflow: phases before the
 * entry point were skipped by design (bug fixes skip specs, trivial changes
 * skip to build), so they can't be required.
 */
export function effectivePredecessor(phase: PhaseName, entry: PhaseName): PhaseName | null {
  if (phase === entry) return null;
  const pred = SPINE[phase].predecessor;
  if (pred === null) return null;
  return PHASE_ORDER.indexOf(pred) < PHASE_ORDER.indexOf(entry) ? null : pred;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/spine.test.ts` — Expected: PASS. Then `pnpm typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/spine.ts test/spine.test.ts
git commit -m "Add declarative spine table: phase artifacts, inputs, predecessors, entry flags"
```

---

### Task 3: Presenter

**Files:**
- Create: `src/workflow/presenter.ts`
- Test: `test/presenter.test.ts`

**Interfaces:**
- Consumes: nothing from this repo.
- Produces: `ApprovalRequest` (`{ title, artifactPath, summary, detail? }`), `Presenter` (`askApproval(req): Promise<boolean>`, `inform(message): void`), `TerminalPresenter` (constructor `(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream)` defaulting to stdin/stdout).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/presenter.test.ts
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalPresenter } from "../src/workflow/presenter.js";

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString("utf8");
}

describe("TerminalPresenter", () => {
  it("approves on y", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({
      title: "specs phase awaiting approval",
      artifactPath: ".tackle/specs.md",
      summary: "wrote the spec",
    });
    input.write("y\n");
    expect(await pending).toBe(true);
    const shown = read();
    expect(shown).toContain("specs phase awaiting approval");
    expect(shown).toContain(".tackle/specs.md");
    expect(shown).toContain("wrote the spec");
  });

  it("treats anything but y/yes as decline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({ title: "t", artifactPath: "a", summary: "" });
    input.write("\n"); // bare enter = decline (default N)
    expect(await pending).toBe(false);
  });

  it("shows detail when given", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({
      title: "t",
      artifactPath: "a",
      summary: "",
      detail: "frozen diff: .tackle/build.diff",
    });
    input.write("yes\n");
    expect(await pending).toBe(true);
    expect(read()).toContain("frozen diff: .tackle/build.diff");
  });

  it("inform writes a line to the output stream", () => {
    const output = new PassThrough();
    const read = collect(output);
    new TerminalPresenter(new PassThrough(), output).inform("hello");
    expect(read()).toBe("hello\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/presenter.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/workflow/presenter.ts
import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  title: string;
  /** Path the human should open and read before deciding. */
  artifactPath: string;
  /** The turn's model-written summary ("" when unknown). */
  summary: string;
  detail?: string;
}

// SPEC.md "Gate semantics": the needs-human-decision presenter is abstracted so
// a later adapter can route it to a notification or an editor; v1 is stdout
// because the operator is present (attended-first).
export interface Presenter {
  askApproval(req: ApprovalRequest): Promise<boolean>;
  inform(message: string): void;
}

export class TerminalPresenter implements Presenter {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  inform(message: string): void {
    this.output.write(message + "\n");
  }

  async askApproval(req: ApprovalRequest): Promise<boolean> {
    this.inform(`\n== ${req.title} ==`);
    this.inform(`artifact: ${req.artifactPath}`);
    if (req.summary.length > 0) this.inform(`summary: ${req.summary}`);
    if (req.detail !== undefined) this.inform(req.detail);
    const rl = createInterface({ input: this.input, output: this.output });
    try {
      const answer = (await rl.question("approve? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/presenter.test.ts` — Expected: PASS. Then `pnpm typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/presenter.ts test/presenter.test.ts
git commit -m "Add human-gate presenter: blocking terminal approval prompt behind an interface"
```

---

### Task 4: Phase prompts

**Files:**
- Create: `src/workflow/prompts.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Consumes: `PhaseDef`, `SPINE` from `src/workflow/spine.ts` (Task 2); `PhaseName` from types.
- Produces: `buildPhasePrompt(opts: PromptOptions): string` where `PromptOptions = { def: PhaseDef; request: string; inputs: Array<{ name: string; path: string; content: string }>; questionsAndAnswers?: string; retryNote?: string }`.
- Contract relied on elsewhere: every phase prompt literally contains the string `running the <name> phase` (the e2e fake adapter keys on it), the artifact path, and the questions-file path.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/prompts.test.ts
import { describe, expect, it } from "vitest";
import { buildPhasePrompt } from "../src/workflow/prompts.js";
import { PHASE_ORDER, SPINE } from "../src/workflow/spine.js";

describe("buildPhasePrompt", () => {
  it("every phase prompt names the phase, its artifact, and its questions file", () => {
    for (const phase of PHASE_ORDER) {
      const def = SPINE[phase];
      const prompt = buildPhasePrompt({ def, request: "do the thing", inputs: [] });
      expect(prompt).toContain(`running the ${phase} phase`);
      expect(prompt).toContain(def.artifact);
      expect(prompt).toContain(def.questionsFile);
      expect(prompt).toContain("## Request\n\ndo the thing");
    }
  });

  it("inlines each input artifact under a labeled section", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.plan,
      request: "r",
      inputs: [{ name: "specs", path: ".tackle/specs.md", content: "# the spec" }],
    });
    expect(prompt).toContain("## Input: specs (.tackle/specs.md)");
    expect(prompt).toContain("# the spec");
  });

  it("carries clarifying Q&A back into the prompt when present", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.specs,
      request: "r",
      inputs: [],
      questionsAndAnswers: "- Q: which env? A: prod",
    });
    expect(prompt).toContain("## Clarifying questions and answers");
    expect(prompt).toContain("- Q: which env? A: prod");
  });

  it("appends the retry note on a retry attempt", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.build,
      request: "r",
      inputs: [],
      retryNote: "The previous attempt completed without writing .tackle/build-notes.md.",
    });
    expect(prompt).toContain("## Previous attempt");
    expect(prompt).toContain("without writing .tackle/build-notes.md");
  });

  it("build prompt forbids committing; pr prompt allows inspecting the repo", () => {
    expect(buildPhasePrompt({ def: SPINE.build, request: "r", inputs: [] })).toContain("Do not commit");
    expect(buildPhasePrompt({ def: SPINE.pr, request: "r", inputs: [] })).toContain("git diff");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/prompts.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/workflow/prompts.ts
import type { PhaseDef } from "./spine.js";
import type { PhaseName } from "./types.js";

export interface PromptOptions {
  def: PhaseDef;
  request: string;
  inputs: Array<{ name: string; path: string; content: string }>;
  /** Content of the questions file (agent questions + human answers), when it exists. */
  questionsAndAnswers?: string;
  /** Set on deterministic-retry attempts to tell the agent what went wrong. */
  retryNote?: string;
}

const PHASE_INSTRUCTIONS: Record<PhaseName, (def: PhaseDef) => string> = {
  specs: (def) =>
    `You are running the specs phase of a phase-gated development workflow. ` +
    `Produce a requirements document for the request below: the problem, the desired behavior, ` +
    `acceptance criteria, non-goals, and open risks. Be concrete enough that a planning pass can ` +
    `work from this document alone. Write the document to ${def.artifact}. ` +
    `Do not modify any other files and do not change source code.`,
  plan: (def) =>
    `You are running the plan phase of a phase-gated development workflow. ` +
    `From the inputs below, produce a step-by-step implementation plan: the files to create or ` +
    `modify, the change in each, the test strategy per step, and commit points. The plan is the ` +
    `primary review artifact — reviewing it is cheaper than reviewing the code it produces, so make ` +
    `it complete enough to judge on its own. Write it to ${def.artifact}. ` +
    `Do not modify any other files and do not change source code.`,
  build: (def) =>
    `You are running the build phase of a phase-gated development workflow. ` +
    `Implement the plan below in this repository, test-first where a test is practical. ` +
    `Do not commit; leave all changes in the working tree — the harness captures the diff as the ` +
    `artifact of record. When done, write ${def.artifact} summarizing what changed, decisions taken, ` +
    `any deviations from the plan, and how you verified the change (tests run and their results).`,
  pr: (def) =>
    `You are running the pr phase of a phase-gated development workflow. ` +
    `Using the inputs below and the repository's current state (inspect \`git diff\` and \`git status\` ` +
    `yourself as needed), write a pull-request body to ${def.artifact}: a summary of the change, the ` +
    `motivation against the spec, test evidence, and any known gaps. ` +
    `Do not modify any other files and do not change source code.`,
};

export function buildPhasePrompt(opts: PromptOptions): string {
  const { def } = opts;
  const sections: string[] = [
    PHASE_INSTRUCTIONS[def.name](def),
    // SPEC.md clarification precondition: detect-ask-wait instead of guessing.
    `Before doing anything else, assess whether your input is complete and unambiguous enough to act ` +
      `on responsibly. If it is not, write your clarifying questions to ${def.questionsFile} as a ` +
      `markdown list and stop: do not write ${def.artifact} and do not make any other changes.`,
    `## Request\n\n${opts.request}`,
  ];
  for (const input of opts.inputs) {
    sections.push(`## Input: ${input.name} (${input.path})\n\n${input.content}`);
  }
  if (opts.questionsAndAnswers !== undefined) {
    sections.push(
      `## Clarifying questions and answers\n\nThese are your questions from an earlier attempt, ` +
        `with the human's answers added. Treat the answers as authoritative.\n\n${opts.questionsAndAnswers}`,
    );
  }
  if (opts.retryNote !== undefined) {
    sections.push(`## Previous attempt\n\n${opts.retryNote}`);
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/prompts.test.ts` — Expected: PASS. Then `pnpm typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/prompts.ts test/prompts.test.ts
git commit -m "Add phase prompt builder with clarification preamble and selective input inlining"
```

---

### Task 5: Phase runner

The orchestrator policy. One function, `runPhase`, drives any phase: workflow start/reset, predecessor gate (with re-presentation of a pending approval — the resume path), the turn loop with deterministic gates (turn status, billing, artifact-exists) under the config'd retry budget, clarification detection, downstream invalidation, the frozen build diff, and the human approval gate.

**Files:**
- Create: `src/workflow/phase.ts`, `test/helpers/workflow.ts`
- Test: `test/phase.test.ts`, `test/phase-resume.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `Adapter`, `Effort`, `TurnResult`, `TurnRequest` from `src/adapter/types.ts`.
- Produces:
  - `PhaseOutcome = "approved" | "rejected" | "needs_clarification" | "halted"`
  - `runPhase(opts: RunPhaseOptions): Promise<PhaseOutcome>` with `RunPhaseOptions = { phase: PhaseName; workdir: string; adapter: Adapter; presenter: Presenter; canEnter: boolean; request?: string; fresh?: boolean; redo?: boolean; effort?: Effort; model?: string; timeoutMs?: number }`.
- Behavioral contract the CLI (Task 6) relies on: only `"approved"` means success; every other outcome maps to exit code 1.

- [ ] **Step 1: Write the shared test helpers and the failing deterministic-gate tests**

The helpers live in `test/helpers/workflow.ts` — NOT inside a `.test.ts` file — so that multiple test files can import them without vitest registering another file's tests twice.

```typescript
// test/helpers/workflow.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, TurnRequest, TurnResult } from "../../src/adapter/types.js";
import { EMPTY_USAGE } from "../../src/adapter/types.js";
import type { Presenter } from "../../src/workflow/presenter.js";

export function fakeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    status: "completed",
    workdirDiff: "",
    transcriptRef: "/tmp/t.jsonl",
    summary: "did the thing",
    sessionId: "s-1",
    authorship: { adapter: "fake", model: null, effort: "medium" },
    usage: { tokens: EMPTY_USAGE, billingType: "subscription" },
    ...overrides,
  };
}

/** Adapter whose run() executes scripted behaviors in call order (last one repeats). */
export function scriptedAdapter(
  behaviors: Array<(req: TurnRequest) => Promise<TurnResult>>,
): Adapter & { prompts: string[] } {
  let call = 0;
  const prompts: string[] = [];
  return {
    name: "fake",
    prompts,
    run: async (req: TurnRequest) => {
      prompts.push(req.prompt);
      const behavior = behaviors[Math.min(call, behaviors.length - 1)];
      call += 1;
      if (behavior === undefined) throw new Error("scriptedAdapter needs at least one behavior");
      return behavior(req);
    },
  };
}

export const approveAll: Presenter = { askApproval: async () => true, inform: () => {} };
export const rejectAll: Presenter = { askApproval: async () => false, inform: () => {} };

export async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tackle-phase-"));
}

export function writesArtifact(relPath: string, content: string, overrides: Partial<TurnResult> = {}) {
  return async (req: TurnRequest): Promise<TurnResult> => {
    await mkdir(join(req.workdir, ".tackle"), { recursive: true });
    await writeFile(join(req.workdir, relPath), content);
    return fakeTurn(overrides);
  };
}
```

```typescript
// test/phase.test.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_USAGE } from "../src/adapter/types.js";
import { runPhase } from "../src/workflow/phase.js";
import { readWorkflowState } from "../src/workflow/state.js";
import {
  approveAll,
  fakeTurn,
  rejectAll,
  scriptedAdapter,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

describe("runPhase deterministic gates", () => {
  it("happy path: runs the turn, records authorship, and approves at the gate", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "add a widget",
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.specs?.status).toBe("approved");
    expect(state?.phases.specs?.lastTurn?.authorship.adapter).toBe("fake");
    expect(state?.request).toBe("add a widget");
    expect(adapter.prompts[0]).toContain("running the specs phase");
  });

  it("retries once when the artifact was not written, with a retry note", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async () => fakeTurn(), // completed but wrote nothing
      writesArtifact(".tackle/specs.md", "# specs"),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(2);
    expect(adapter.prompts[1]).toContain("## Previous attempt");
  });

  it("retries once on a non-completed turn status", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async () => fakeTurn({ status: "tool_error" }),
      writesArtifact(".tackle/specs.md", "# specs"),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts[1]).toContain('status "tool_error"');
  });

  it("halts after the retry budget is exhausted and records the halted state", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([async () => fakeTurn({ status: "timeout" })]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(2); // 1 attempt + deterministicRetries(1)
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("halted");
  });

  it("halts immediately on a metered turn without retrying (billing gate)", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/specs.md", "# specs", {
        usage: { tokens: EMPTY_USAGE, billingType: "metered" },
      }),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(1);
  });

  it("respects deterministicRetries from .tackle/config.json", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 0 }));
    const adapter = scriptedAdapter([async () => fakeTurn({ status: "timeout" })]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(1);
  });

  it("freezes the build diff to .tackle/build.diff", async () => {
    const dir = await tempWorkdir();
    const diff = "diff --git a/x.ts b/x.ts\n+added\n";
    // enter at build (trivial change) so no predecessors are required
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/build-notes.md", "# notes", { workdirDiff: diff }),
    ]);
    const outcome = await runPhase({
      phase: "build", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "tiny fix",
    });
    expect(outcome).toBe("approved");
    expect(await readFile(join(dir, ".tackle", "build.diff"), "utf8")).toBe(diff);
  });

  it("declined approval leaves the phase awaiting_approval and returns rejected", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: rejectAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("rejected");
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("awaiting_approval");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/phase.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement runPhase**

```typescript
// src/workflow/phase.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Effort, TurnResult } from "../adapter/types.js";
import { readArtifact, removeArtifact } from "./artifacts.js";
import type { Presenter } from "./presenter.js";
import { buildPhasePrompt } from "./prompts.js";
import { BUILD_DIFF_FILE, effectivePredecessor, PHASE_ORDER, SPINE } from "./spine.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "./state.js";
import type { PhaseName, TurnRecord, WorkflowState } from "./types.js";

export type PhaseOutcome = "approved" | "rejected" | "needs_clarification" | "halted";

export interface RunPhaseOptions {
  phase: PhaseName;
  workdir: string;
  adapter: Adapter;
  presenter: Presenter;
  /** true when this invocation may start a new workflow at this phase (specs, --skip-specs, --trivial). */
  canEnter: boolean;
  request?: string;
  /** Discard any in-progress workflow and start over at this phase (needs canEnter). */
  fresh?: boolean;
  /** Re-run this phase's turn even if its artifact is approved or awaiting approval. */
  redo?: boolean;
  effort?: Effort;
  model?: string;
  timeoutMs?: number;
}

function toTurnRecord(result: TurnResult): TurnRecord {
  return {
    status: result.status,
    summary: result.summary,
    authorship: result.authorship,
    billingType: result.usage.billingType,
    transcriptRef: result.transcriptRef,
    sessionId: result.sessionId,
  };
}

/**
 * Present the blocking approval gate for a phase whose artifact is on disk.
 * Serves both the end-of-phase gate and resume: a pending gate from an earlier
 * (possibly killed) run is re-presented by the next command that needs it.
 */
async function presentGate(
  phase: PhaseName,
  state: WorkflowState,
  opts: Pick<RunPhaseOptions, "workdir" | "presenter">,
): Promise<boolean> {
  const def = SPINE[phase];
  const phaseState = state.phases[phase];
  if (phaseState === undefined) throw new Error(`no ${phase} state to present`);
  const approved = await opts.presenter.askApproval({
    title: `${phase} phase awaiting approval`,
    artifactPath: def.artifact,
    summary: phaseState.lastTurn?.summary ?? "",
    ...(phase === "build" ? { detail: `frozen diff: ${BUILD_DIFF_FILE}` } : {}),
  });
  if (approved) {
    phaseState.status = "approved";
    await writeWorkflowState(opts.workdir, state);
  }
  return approved;
}

export async function runPhase(opts: RunPhaseOptions): Promise<PhaseOutcome> {
  const def = SPINE[opts.phase];
  const { presenter, workdir } = opts;
  let state = await readWorkflowState(workdir);

  // -- workflow start / reset -------------------------------------------------
  if (state === null || (opts.fresh === true && opts.canEnter)) {
    if (!opts.canEnter) {
      presenter.inform(`no workflow in progress; start one with \`tackle specs "<request>"\``);
      return "halted";
    }
    if (opts.request === undefined) {
      presenter.inform(`starting a workflow at ${opts.phase} requires a request argument`);
      return "halted";
    }
    state = { version: 1, request: opts.request, entry: opts.phase, phases: {} };
    for (const p of PHASE_ORDER) {
      await removeArtifact(workdir, SPINE[p].artifact);
      await removeArtifact(workdir, SPINE[p].questionsFile);
    }
    await removeArtifact(workdir, BUILD_DIFF_FILE);
    await writeWorkflowState(workdir, state);
  } else if (opts.request !== undefined) {
    state.request = opts.request; // amending the ask on a re-run; persisted below
  }

  if (PHASE_ORDER.indexOf(opts.phase) < PHASE_ORDER.indexOf(state.entry)) {
    presenter.inform(
      `this workflow entered at ${state.entry}, so ${opts.phase} is not part of it; ` +
        `pass --fresh to start a new workflow from ${opts.phase}`,
    );
    return "halted";
  }

  // -- predecessor gate (and resume of a pending approval) ---------------------
  const pred = effectivePredecessor(opts.phase, state.entry);
  if (pred !== null) {
    const predState = state.phases[pred];
    if (predState === undefined || predState.status === "halted" || predState.status === "needs_clarification") {
      presenter.inform(`${pred} phase is not complete; run \`tackle ${pred}\` first`);
      return "halted";
    }
    if (predState.status === "awaiting_approval") {
      const ok = await presentGate(pred, state, opts);
      if (!ok) return "rejected";
    }
  }

  // -- own-phase resume: don't re-run a turn whose artifact awaits judgment ----
  const own = state.phases[opts.phase];
  if (own !== undefined && opts.redo !== true) {
    if (own.status === "approved") {
      presenter.inform(`${opts.phase} is already approved; pass --redo to run it again`);
      return "approved";
    }
    if (own.status === "awaiting_approval") {
      return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
    }
  }

  // -- running (or re-running) this phase invalidates everything after it ------
  for (const later of PHASE_ORDER.slice(PHASE_ORDER.indexOf(opts.phase) + 1)) {
    delete state.phases[later];
    await removeArtifact(workdir, SPINE[later].artifact);
    await removeArtifact(workdir, SPINE[later].questionsFile);
  }
  if (PHASE_ORDER.indexOf(opts.phase) <= PHASE_ORDER.indexOf("build")) {
    await removeArtifact(workdir, BUILD_DIFF_FILE);
  }
  // A stale artifact must not satisfy the gate for a fresh turn.
  await removeArtifact(workdir, def.artifact);
  await writeWorkflowState(workdir, state);

  // -- gather the turn's inputs (selective load) --------------------------------
  const policy = await loadPolicyConfig(workdir);
  const questionsAndAnswers = (await readArtifact(workdir, def.questionsFile)) ?? undefined;
  const inputs: Array<{ name: string; path: string; content: string }> = [];
  for (const inputPhase of def.inputs) {
    // Missing inputs are phases skipped by the entry point, not errors.
    const content = await readArtifact(workdir, SPINE[inputPhase].artifact);
    if (content !== null) inputs.push({ name: inputPhase, path: SPINE[inputPhase].artifact, content });
  }

  // -- the turn loop under the deterministic-gate policy ------------------------
  let completed: TurnResult | null = null;
  let lastTurn: TurnResult | null = null;
  let retryNote: string | undefined;
  for (let attempt = 0; attempt <= policy.deterministicRetries; attempt++) {
    const prompt = buildPhasePrompt({
      def,
      request: state.request,
      inputs,
      ...(questionsAndAnswers === undefined ? {} : { questionsAndAnswers }),
      ...(retryNote === undefined ? {} : { retryNote }),
    });
    const result = await opts.adapter.run({
      prompt,
      workdir,
      effort: opts.effort ?? "medium",
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    lastTurn = result;

    // Billing gate: no retry — re-running would bill metered again.
    if (result.usage.billingType === "metered") {
      state.phases[opts.phase] = { status: "halted", lastTurn: toTurnRecord(result) };
      await writeWorkflowState(workdir, state);
      presenter.inform(
        "halted: turn billed metered; fix adapter auth before re-running (subscription-before-API gate)",
      );
      return "halted";
    }
    if (result.status !== "completed") {
      retryNote = `The previous attempt ended with status "${result.status}" before finishing. Start over and complete the phase.`;
      continue;
    }
    const artifact = await readArtifact(workdir, def.artifact);
    if (artifact !== null) {
      completed = result;
      break;
    }
    // Clarification precondition: questions written instead of the artifact.
    // Comparing against the pre-turn content distinguishes a fresh ask from
    // the stale Q&A file that rode into this turn's prompt.
    const questions = await readArtifact(workdir, def.questionsFile);
    if (questions !== null && questions !== questionsAndAnswers) {
      state.phases[opts.phase] = { status: "needs_clarification", lastTurn: toTurnRecord(result) };
      await writeWorkflowState(workdir, state);
      presenter.inform(
        `${opts.phase} needs clarification: answer the questions in ${def.questionsFile} in place, ` +
          `then re-run \`tackle ${opts.phase}\``,
      );
      return "needs_clarification";
    }
    retryNote = `The previous attempt completed without writing ${def.artifact}. You must write that file.`;
  }

  if (completed === null) {
    state.phases[opts.phase] = {
      status: "halted",
      ...(lastTurn === null ? {} : { lastTurn: toTurnRecord(lastTurn) }),
    };
    await writeWorkflowState(workdir, state);
    presenter.inform(
      `${opts.phase} halted after ${policy.deterministicRetries + 1} attempt(s); needs a human decision ` +
        `(last status: ${lastTurn?.status ?? "no turn ran"})`,
    );
    return "halted";
  }

  // The diff is the build phase's artifact of record; freeze it for the review gate.
  if (opts.phase === "build") {
    await writeFile(join(workdir, BUILD_DIFF_FILE), completed.workdirDiff);
    if (completed.workdirDiff.length === 0) presenter.inform("warning: build produced an empty diff");
  }

  state.phases[opts.phase] = { status: "awaiting_approval", lastTurn: toTurnRecord(completed) };
  await writeWorkflowState(workdir, state);
  return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
}
```

- [ ] **Step 4: Run the deterministic-gate tests**

Run: `pnpm vitest run test/phase.test.ts` — Expected: PASS (8 tests). Then `pnpm typecheck` — clean.

- [ ] **Step 5: Write the failing resume/clarification tests**

```typescript
// test/phase-resume.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPhase } from "../src/workflow/phase.js";
import { readWorkflowState } from "../src/workflow/state.js";
import {
  approveAll,
  fakeTurn,
  rejectAll,
  scriptedAdapter,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

describe("clarification round-trip", () => {
  it("halts with needs_clarification when questions are written instead of the artifact", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async (req) => {
        // .tackle/ exists: workflow.json was written before the turn
        await writeFile(join(req.workdir, ".tackle", "specs-questions.md"), "- which env?");
        return fakeTurn({ summary: "asked questions" });
      },
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "vague ask",
    });
    expect(outcome).toBe("needs_clarification");
    expect(adapter.prompts).toHaveLength(1); // clarification is not a retryable failure
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("needs_clarification");
  });

  it("carries the answered questions into the next run's prompt", async () => {
    const dir = await tempWorkdir();
    const first = scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, ".tackle", "specs-questions.md"), "- which env?");
        return fakeTurn();
      },
    ]);
    await runPhase({
      phase: "specs", workdir: dir, adapter: first, presenter: approveAll, canEnter: true, request: "vague ask",
    });
    // the human answers in place
    await writeFile(join(dir, ".tackle", "specs-questions.md"), "- which env? A: prod");
    const second = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter: second, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(second.prompts[0]).toContain("## Clarifying questions and answers");
    expect(second.prompts[0]).toContain("A: prod");
  });
});

describe("entry, resume, and invalidation", () => {
  it("plan --skip-specs starts a workflow entered at plan with no predecessor", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]);
    const outcome = await runPhase({
      phase: "plan", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "fix the crash",
    });
    expect(outcome).toBe("approved");
    expect((await readWorkflowState(dir))?.entry).toBe("plan");
  });

  it("refuses a non-entry phase with no workflow in progress", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/pr.md", "# pr")]);
    const outcome = await runPhase({
      phase: "pr", workdir: dir, adapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(0);
  });

  it("refuses a phase that precedes the workflow's entry point", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]),
      presenter: approveAll, canEnter: true, request: "fix",
    });
    const specsAdapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter: specsAdapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("halted");
    expect(specsAdapter.prompts).toHaveLength(0);
  });

  it("blocks a phase whose predecessor has not run", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: approveAll, canEnter: true, request: "r",
    });
    const buildAdapter = scriptedAdapter([writesArtifact(".tackle/build-notes.md", "# notes")]);
    const outcome = await runPhase({
      phase: "build", workdir: dir, adapter: buildAdapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("halted"); // plan never ran
    expect(buildAdapter.prompts).toHaveLength(0);
  });

  it("re-presents a pending predecessor gate before running (resume path)", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: rejectAll, canEnter: true, request: "r",
    }); // specs left awaiting_approval, as after a kill
    const planAdapter = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]);
    const outcome = await runPhase({
      phase: "plan", workdir: dir, adapter: planAdapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.specs?.status).toBe("approved");
    expect(state?.phases.plan?.status).toBe("approved");
    expect(planAdapter.prompts[0]).toContain("# specs"); // approved spec was inlined
  });

  it("re-presents this phase's own pending gate instead of re-running the turn", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: rejectAll, canEnter: true, request: "r",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(1); // no second turn
  });

  it("--redo re-runs an approved phase and invalidates downstream artifacts", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs v1")]),
      presenter: approveAll, canEnter: true, request: "r",
    });
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan v1")]),
      presenter: approveAll, canEnter: false,
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs v2")]),
      presenter: approveAll, canEnter: true, redo: true,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.plan).toBeUndefined(); // downstream state invalidated
    await expect(readFile(join(dir, ".tackle", "plan.md"), "utf8")).rejects.toThrow(); // artifact removed
    expect(await readFile(join(dir, ".tackle", "specs.md"), "utf8")).toBe("# specs v2");
  });

  it("--fresh discards the old workflow and its artifacts", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# old plan")]),
      presenter: approveAll, canEnter: true, request: "old",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: approveAll, canEnter: true, request: "new", fresh: true,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.entry).toBe("specs");
    expect(state?.request).toBe("new");
    expect(state?.phases.plan).toBeUndefined();
    await expect(readFile(join(dir, ".tackle", "plan.md"), "utf8")).rejects.toThrow();
  });

  it("already-approved phase without --redo is a no-op returning approved", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run the resume tests, fix anything they surface**

Run: `pnpm vitest run test/phase-resume.test.ts` — Expected: PASS against the Step 3 implementation (it was written to cover these paths). If a test fails, fix `phase.ts`, not the test, unless the test contradicts the design decisions pinned above.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck` — Expected: all green (53 existing + new).

- [ ] **Step 8: Commit**

```bash
git add src/workflow/phase.ts test/phase.test.ts test/phase-resume.test.ts
git commit -m "Add phase runner: deterministic gates, clarification, resume, human approval gate"
```

---

### Task 6: CLI commands

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-phases.test.ts` (existing `test/cli.test.ts` and `test/cli-turn.test.ts` must keep passing)

**Interfaces:**
- Consumes: `runPhase`, `PhaseOutcome` (Task 5); `Presenter`, `TerminalPresenter` (Task 3); `readWorkflowState` (Task 1); `PHASE_ORDER`, `SPINE` (Task 2).
- Produces: `buildProgram(opts: { adapter?: Adapter; presenter?: Presenter; writeOut?: (s: string) => void })` — new optional `presenter`; commands `tackle specs <request>`, `tackle plan [request]`, `tackle build [request]`, `tackle pr`, `tackle status`. Shared options on the four phase commands: `--cwd`, `--effort`, `--model`, `--timeout`, `--redo`; `--fresh` on specs/plan/build; `--skip-specs` on plan; `--trivial` on build.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/cli-phases.test.ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { approveAll, fakeTurn, rejectAll } from "./helpers/workflow.js";

function artifactWritingAdapter(relPath: string): Adapter & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    name: "fake",
    requests,
    run: async (req: TurnRequest) => {
      requests.push(req);
      await mkdir(join(req.workdir, ".tackle"), { recursive: true });
      await writeFile(join(req.workdir, relPath), "# artifact");
      return fakeTurn();
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("tackle phase commands", () => {
  it("tackle specs runs the phase and exits 0 on approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const adapter = artifactWritingAdapter(".tackle/specs.md");
    const program = buildProgram({ adapter, presenter: approveAll, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.status).toBe("approved");
    expect(adapter.requests[0]?.effort).toBe("medium");
  });

  it("passes effort, model, and timeout through to the adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const adapter = artifactWritingAdapter(".tackle/specs.md");
    const program = buildProgram({ adapter, presenter: approveAll, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(
      ["specs", "r", "--cwd", dir, "--effort", "high", "--model", "gpt-x", "--timeout", "30"],
      { from: "user" },
    );
    expect(adapter.requests[0]?.effort).toBe("high");
    expect(adapter.requests[0]?.model).toBe("gpt-x");
    expect(adapter.requests[0]?.timeoutMs).toBe(30_000);
  });

  it("sets exit code 1 when the human declines the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/specs.md"),
      presenter: rejectAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await program.parseAsync(["specs", "r", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it("tackle plan --skip-specs without a request is an error", async () => {
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/plan.md"),
      presenter: approveAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await expect(
      program.parseAsync(["plan", "--skip-specs"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("tackle pr takes no request argument", async () => {
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/pr.md"),
      presenter: approveAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await expect(program.parseAsync(["pr", "unexpected"], { from: "user" })).rejects.toThrow();
  });

  it("tackle status reports no workflow, then per-phase status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const out: string[] = [];
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/specs.md"),
      presenter: approveAll,
      writeOut: (s) => out.push(s),
    });
    program.exitOverride();
    await program.parseAsync(["status", "--cwd", dir], { from: "user" });
    expect(out.join("")).toContain("no workflow in progress");

    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    out.length = 0;
    await program.parseAsync(["status", "--cwd", dir], { from: "user" });
    const text = out.join("");
    expect(text).toContain("request: add a widget");
    expect(text).toContain("entry: specs");
    expect(text).toMatch(/specs\s+approved/);
    expect(text).toMatch(/plan\s+pending/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/cli-phases.test.ts` — Expected: FAIL (`unknown command 'specs'`).

- [ ] **Step 3: Implement the commands**

Modify `src/cli.ts`. Full replacement content:

```typescript
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { CodexAdapter } from "./adapter/codex/index.js";
import type { Adapter, Effort } from "./adapter/types.js";
import { runPhase } from "./workflow/phase.js";
import type { Presenter } from "./workflow/presenter.js";
import { TerminalPresenter } from "./workflow/presenter.js";
import { readWorkflowState } from "./workflow/state.js";
import { PHASE_ORDER, SPINE } from "./workflow/spine.js";
import type { PhaseName } from "./workflow/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

function parseTimeout(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("timeout must be a positive number");
  return n;
}

function withTurnOptions(cmd: Command): Command {
  return cmd
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .addOption(new Option("--effort <band>", "effort band").choices(["low", "medium", "high"]).default("medium"))
    .option("--model <model>", "model override (default: backend default)")
    .option("--timeout <seconds>", "turn timeout in seconds", parseTimeout);
}

interface PhaseCliOptions {
  cwd: string;
  effort: Effort;
  model?: string;
  timeout?: number;
  fresh?: boolean;
  redo?: boolean;
  skipSpecs?: boolean;
  trivial?: boolean;
}

export function buildProgram(
  opts: { adapter?: Adapter; presenter?: Presenter; writeOut?: (s: string) => void } = {},
): Command {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);

  withTurnOptions(
    program
      .command("turn")
      .description("Run a single turn through an adapter and print the TurnResult")
      .argument("<prompt>", "the prompt for the turn"),
  ).action(async (prompt: string, options: PhaseCliOptions) => {
    const adapter = opts.adapter ?? new CodexAdapter();
    const result = await adapter.run({
      prompt,
      workdir: options.cwd,
      effort: options.effort,
      model: options.model,
      timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
    });
    writeOut(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "completed") process.exitCode = 1;
  });

  async function executePhase(
    phase: PhaseName,
    request: string | undefined,
    options: PhaseCliOptions,
  ): Promise<void> {
    const enteringHere =
      phase === "specs" || options.skipSpecs === true || options.trivial === true;
    if (enteringHere && phase !== "specs" && request === undefined) {
      throw new InvalidArgumentError(`starting a workflow at ${phase} requires a request argument`);
    }
    const adapter = opts.adapter ?? new CodexAdapter();
    const presenter = opts.presenter ?? new TerminalPresenter();
    const outcome = await runPhase({
      phase,
      workdir: options.cwd,
      adapter,
      presenter,
      canEnter: enteringHere,
      ...(request === undefined ? {} : { request }),
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      ...(options.redo === undefined ? {} : { redo: options.redo }),
      effort: options.effort,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
    });
    if (outcome !== "approved") process.exitCode = 1;
  }

  withTurnOptions(
    program
      .command("specs")
      .description("Write .tackle/specs.md from a request (workflow entry)")
      .argument("<request>", "what to build"),
  )
    .option("--fresh", "discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string, options: PhaseCliOptions) => executePhase("specs", request, options));

  withTurnOptions(
    program
      .command("plan")
      .description("Write .tackle/plan.md from the approved specs")
      .argument("[request]", "amended or entry request"),
  )
    .option("--skip-specs", "start the workflow at plan (bug fixes)")
    .option("--fresh", "with --skip-specs: discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string | undefined, options: PhaseCliOptions) =>
      executePhase("plan", request, options),
    );

  withTurnOptions(
    program
      .command("build")
      .description("Implement the approved plan; freeze the diff to .tackle/build.diff")
      .argument("[request]", "amended or entry request"),
  )
    .option("--trivial", "start the workflow at build (trivial changes)")
    .option("--fresh", "with --trivial: discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string | undefined, options: PhaseCliOptions) =>
      executePhase("build", request, options),
    );

  withTurnOptions(
    program.command("pr").description("Write the PR body to .tackle/pr.md from the build artifacts"),
  )
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (options: PhaseCliOptions) => executePhase("pr", undefined, options));

  program
    .command("status")
    .description("Show the workflow state")
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .action(async (options: { cwd: string }) => {
      const state = await readWorkflowState(options.cwd);
      if (state === null) {
        writeOut("no workflow in progress\n");
        return;
      }
      writeOut(`request: ${state.request}\nentry: ${state.entry}\n`);
      for (const phase of PHASE_ORDER) {
        if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(state.entry)) continue;
        const status = state.phases[phase]?.status ?? "pending";
        writeOut(`${phase.padEnd(6)} ${status.padEnd(20)} ${SPINE[phase].artifact}\n`);
      }
    });

  return program;
}

// argv[1] can be a symlink (e.g. a node_modules/.bin shim from `pnpm link`);
// realpath it before comparing so this still resolves to true through a link.
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
```

Note the `turn` command's behavior is unchanged — only its option setup moved into `withTurnOptions`. Commander subcommands reject unknown positional arguments by default, which is what the `tackle pr unexpected` test relies on.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/cli-phases.test.ts test/cli.test.ts test/cli-turn.test.ts` — Expected: PASS, including the two pre-existing CLI test files (the `turn` refactor must not change behavior).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli-phases.test.ts
git commit -m "Add specs/plan/build/pr/status commands driving the phase runner"
```

---

### Task 7: End-to-end spine test, README, decision record

**Files:**
- Test: `test/spine-e2e.test.ts`
- Modify: `README.md` (usage section), `decisions.md` (append D-004)

**Interfaces:**
- Consumes: everything; exercises only public surfaces (`buildProgram`, files on disk).
- Produces: nothing new — proof the spine holds end to end.

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/spine-e2e.test.ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { approveAll, fakeTurn, rejectAll } from "./helpers/workflow.js";

const BUILD_DIFF = "diff --git a/w.ts b/w.ts\n+export const w = 1;\n";

/** Plays each phase by keying on the prompt's "running the <phase> phase" marker. */
function phasePlayingAdapter(): Adapter {
  return {
    name: "fake",
    run: async (req: TurnRequest) => {
      const t = join(req.workdir, ".tackle");
      await mkdir(t, { recursive: true });
      if (req.prompt.includes("running the specs phase")) {
        await writeFile(join(t, "specs.md"), "# specs: widget\nacceptance: renders\n");
        return fakeTurn({ summary: "wrote specs" });
      }
      if (req.prompt.includes("running the plan phase")) {
        expect(req.prompt).toContain("# specs: widget"); // selective load carried the spec in
        await writeFile(join(t, "plan.md"), "# plan: add w.ts\n");
        return fakeTurn({ summary: "wrote plan" });
      }
      if (req.prompt.includes("running the build phase")) {
        expect(req.prompt).toContain("# plan: add w.ts");
        await writeFile(join(t, "build-notes.md"), "# notes: added w.ts, tests pass\n");
        return fakeTurn({ summary: "built it", workdirDiff: BUILD_DIFF });
      }
      if (req.prompt.includes("running the pr phase")) {
        expect(req.prompt).toContain("# specs: widget");
        expect(req.prompt).toContain("# notes: added w.ts");
        await writeFile(join(t, "pr.md"), "# PR: add widget\n");
        return fakeTurn({ summary: "wrote pr body" });
      }
      throw new Error(`unrecognized phase prompt: ${req.prompt.slice(0, 80)}`);
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("the workflow spine end to end", () => {
  it("runs specs -> plan -> build -> pr, leaving all artifacts and approvals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-e2e-"));
    const program = buildProgram({ adapter: phasePlayingAdapter(), presenter: approveAll, writeOut: () => {} });
    program.exitOverride();

    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
    await program.parseAsync(["build", "--cwd", dir], { from: "user" });
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    for (const phase of ["specs", "plan", "build", "pr"]) {
      expect(state.phases[phase].status).toBe("approved");
    }
    expect(await readFile(join(dir, ".tackle", "build.diff"), "utf8")).toBe(BUILD_DIFF);
    expect(await readFile(join(dir, ".tackle", "pr.md"), "utf8")).toContain("# PR: add widget");
    // the authorship record is on every phase (cross-model gate's future input)
    expect(state.phases.build.lastTurn.authorship.adapter).toBe("fake");
  });

  it("resumes across processes: a declined gate is re-presented by the next command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-e2e-"));
    const first = buildProgram({ adapter: phasePlayingAdapter(), presenter: rejectAll, writeOut: () => {} });
    first.exitOverride();
    await first.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBe(1); // declined
    process.exitCode = undefined;

    // "new process": fresh program, approving presenter
    const second = buildProgram({ adapter: phasePlayingAdapter(), presenter: approveAll, writeOut: () => {} });
    second.exitOverride();
    await second.parseAsync(["plan", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.status).toBe("approved"); // gate re-presented and approved
    expect(state.phases.plan.status).toBe("approved");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `pnpm vitest run test/spine-e2e.test.ts` — Expected: PASS. Any failure here is an integration bug in Tasks 5–6; fix the source, not the test.

- [ ] **Step 3: Update README and decisions.md**

Append to `README.md` (after the existing `tackle turn` usage):

```markdown
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
```

Append to `decisions.md`:

```markdown
## D-004 · 2026-07-02 · Human gate is the phase command's own blocking prompt, re-presented on resume

The approval prompt fires at the end of each phase command; a declined or orphaned
gate is re-presented by the next phase command before it proceeds, which is also the
crash-resume path (resume-from-artifacts needs no extra machinery). Only `approved`
exits 0, so `tackle plan && tackle build` chains safely. **Rejected:** a separate
`tackle approve` command (a second command per phase in the common path, and two
sources of truth for gate state); auto-approve on artifact-exists (violates
attended-first).
```

- [ ] **Step 4: Full suite, typecheck, build**

Run: `pnpm test && pnpm typecheck && pnpm build` — Expected: all green.

- [ ] **Step 5 (optional, requires Codex CLI + subscription auth): live smoke**

In a scratch git repo: `pnpm dev specs "add a hello-world script"` — expect a real turn, a `.tackle/specs.md`, and the terminal approval prompt. Record the result in `docs/plans/2026-07-02-workflow-spine-notes.md` the way the skeleton smoke was recorded.

- [ ] **Step 6: Commit and close the bead**

```bash
git add test/spine-e2e.test.ts README.md decisions.md
git commit -m "Prove the spine end to end; document usage and the human-gate decision"
bd close tackle-atq
```

---

## Self-Review

- **Spec coverage:** spine order + per-phase files + human gate (Tasks 2, 5, 6); skips via `--skip-specs`/`--trivial` (Tasks 2, 5); plan-as-primary-review-artifact (prompt wording, Task 4); selective load (spine `inputs`, Tasks 2, 5, verified in e2e); clarification precondition (Tasks 4, 5); resume-from-artifacts (Task 5 gate re-presentation + `status`, e2e second test); gate semantics worker/policy split with config'd budgets (Tasks 1, 5); billing as deterministic gate (Task 5); frozen diff + authorship record persisted for tackle-483 (Tasks 1, 5). Deliberately deferred: review gate loop (tackle-483), `~40%` context ceiling as a measured budget (meaningless until phases carry more than these small documents — the selective-load mechanism is the enforcement), dynamic workflows (Phase 4).
- **Placeholder scan:** none — every step carries full code or exact commands.
- **Type consistency:** `TurnRecord.summary` added in Task 1 and consumed in Task 5's `presentGate`; `canEnter`/`fresh`/`redo` names match between Task 5's `RunPhaseOptions` and Task 6's CLI; prompt marker `running the <phase> phase` pinned in Task 4's tests and relied on in Task 7's fake adapter; conditional-spread used everywhere an optional property is set (tsconfig has `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is off today but the code stays clean if it's ever enabled).
