# Pre-commit Review Gate (tackle-483) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `review` phase between build and pr: a cross-model reviewer (new minimal Claude Code adapter) loops against the frozen build diff until clean, then — after the human gate — stages and commits only when the staged content hashes to exactly what the reviewer passed. Approved artifacts are hash-pinned at approval time.

**Architecture:** Per the approved design (`docs/plans/2026-07-02-review-gate-design.md`): `review` joins the SPINE table but runs through a dedicated `runReviewPhase()` (not `runPhase`) because it alternates two adapters and ends in a git side effect. A new `src/adapter/claude/` mirrors `src/adapter/codex/` and detects subscription billing from the Claude credential store, fail closed. Hash pinning lives in `presentGate` (one place, all phases).

**Tech Stack:** TypeScript (Node 20+, ESM, `.js` import specifiers), commander, vitest. No new dependencies — hashing uses `node:crypto`.

## Global Constraints

- Run tests with `pnpm test` (vitest). Typecheck with `pnpm build` (tsc). Both must be green at every commit.
- All imports of local modules use `.js` extensions (ESM).
- Fail closed everywhere: unknown billing halts, unknown authorship halts, unparseable verdicts halt (after the deterministic retry), hash mismatches halt.
- No commit message mentions any AI model or tool.
- `.tackle/` is gitignored and must never be committed by the commit chain.
- Exact-optional-property style: this codebase spreads optional fields (`...(x === undefined ? {} : { x })`) rather than passing `undefined`. Follow it.

## Facts pinned by live probe (do not re-derive)

- `claude -p --output-format json` prints ONE JSON object to stdout with fields: `type: "result"`, `subtype: "success"`, `is_error: boolean`, `result: string` (final text), `session_id: string`, `usage: { input_tokens, cache_read_input_tokens, output_tokens, ... }`. `total_cost_usd` is reported even on subscription — cost is NOT a billing signal.
- `claude -p` reads the prompt from stdin when no positional prompt is given.
- Relevant flags (verified against the installed CLI): `--output-format json`, `--setting-sources ""` (loads no user/project settings — no hooks, plugins, or apiKeyHelper), `--strict-mcp-config` (no MCP servers), `--disallowedTools <list>`, `--effort low|medium|high` (accepts our Effort values directly), `--model <model>`.
- Subscription credentials: macOS Keychain item `Claude Code-credentials` (read via `security find-generic-password -s "Claude Code-credentials" -w`), JSON with `claudeAiOauth.subscriptionType` (e.g. `"max"`). On other platforms the same JSON lives at `~/.claude/.credentials.json`.
- `buildAdapterEnv` bans `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from subprocess envs, so the claude subprocess always authenticates via stored OAuth.

## Design refinement (documented deviation)

The design doc says fix-round diff custody is pinned "in the review phase's state". Implementation stores the current frozen-diff hash in `state.phases.build.diffHash`, updating it at each re-freeze. Reason: the review phase's state is cleared when review re-runs, so a pin stored there cannot survive a killed fix loop; keeping one field that always means "hash of the currently frozen `.tackle/build.diff`" makes resume after a mid-loop kill work (drift check passes against the updated pin and review restarts at round 1 against the fixed tree). Same mechanism, storage location adjusted for resume-correctness.

---

### Task 1: Hash pinning at approval + input verification

**Files:**
- Create: `src/workflow/hash.ts`
- Modify: `src/workflow/types.ts` (PhaseState)
- Modify: `src/workflow/phase.ts` (presentGate, input gathering; export `presentGate` and `toTurnRecord`)
- Test: `test/artifact-pinning.test.ts`

**Interfaces:**
- Consumes: existing `presentGate`, `readArtifact`, `WorkflowState`.
- Produces: `sha256(content: string): string` (hex) from `src/workflow/hash.ts`; `PhaseState.artifactHash?: string` and `PhaseState.diffHash?: string`; exported `presentGate(phase, state, opts): Promise<boolean>` and `toTurnRecord(result: TurnResult): TurnRecord` from `src/workflow/phase.ts`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/artifact-pinning.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPhase } from "../src/workflow/phase.js";
import { sha256 } from "../src/workflow/hash.js";
import {
  approveAll,
  capturingPresenter,
  scriptedAdapter,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

describe("artifact pinning at approval", () => {
  it("records the artifact hash when a gate is approved", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r" });
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.artifactHash).toBe(sha256("# specs\n"));
  });

  it("pins the frozen diff hash when the build gate is approved", async () => {
    const dir = await tempWorkdir();
    const diff = "diff --git a/x b/x\n+x\n";
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/build-notes.md", "# notes\n", { workdirDiff: diff }),
    ]);
    await runPhase({ phase: "build", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r" });
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.build.diffHash).toBe(sha256(diff));
  });

  it("halts a phase whose approved input artifact was modified after approval", async () => {
    const dir = await tempWorkdir();
    const specs = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter: specs, presenter: approveAll, canEnter: true, request: "r" });
    await writeFile(join(dir, ".tackle", "specs.md"), "# tampered\n"); // post-approval rewrite
    const presenter = capturingPresenter(true);
    const plan = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan\n")]);
    const outcome = await runPhase({ phase: "plan", workdir: dir, adapter: plan, presenter, canEnter: false });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed after specs was approved");
  });

  it("accepts an unmodified approved input", async () => {
    const dir = await tempWorkdir();
    const specs = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter: specs, presenter: approveAll, canEnter: true, request: "r" });
    const plan = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan\n")]);
    const outcome = await runPhase({ phase: "plan", workdir: dir, adapter: plan, presenter: approveAll, canEnter: false });
    expect(outcome).toBe("approved");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/artifact-pinning.test.ts`
Expected: FAIL — `src/workflow/hash.js` does not exist; `artifactHash`/`diffHash` undefined.

- [ ] **Step 3: Implement**

`src/workflow/hash.ts` (complete file):

```typescript
import { createHash } from "node:crypto";

/** Hex sha256 of a UTF-8 string — the pin format for approved artifacts and frozen diffs. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
```

`src/workflow/types.ts` — extend `PhaseState`:

```typescript
export interface PhaseState {
  status: PhaseStatus;
  lastTurn?: TurnRecord;
  /** sha256 of the artifact file, pinned at approval time (SPEC artifact integrity). */
  artifactHash?: string;
  /** build only: sha256 of the currently frozen .tackle/build.diff (see design refinement). */
  diffHash?: string;
}
```

`src/workflow/phase.ts` — three edits.

(a) Export `toTurnRecord` (add `export` keyword to the existing function).

(b) Export `presentGate` and pin hashes on approval. Replace the `if (approved)` body:

```typescript
export async function presentGate(
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
    // Pin what was approved: later consumers verify against these hashes so a
    // subsequent turn cannot silently rewrite an already-approved artifact.
    const artifact = await readArtifact(opts.workdir, def.artifact);
    if (artifact !== null) phaseState.artifactHash = sha256(artifact);
    if (phase === "build") {
      const diff = await readArtifact(opts.workdir, BUILD_DIFF_FILE);
      if (diff !== null) phaseState.diffHash = sha256(diff);
    }
    await writeWorkflowState(opts.workdir, state);
  }
  return approved;
}
```

Add `import { sha256 } from "./hash.js";` at the top.

(c) Verify pinned inputs in the gathering loop. Replace the input-gathering `for` body:

```typescript
  for (const inputPhase of def.inputs) {
    // Missing inputs are phases skipped by the entry point, not errors.
    const content = await readArtifact(workdir, SPINE[inputPhase].artifact);
    if (content === null) continue;
    const pinned = state.phases[inputPhase]?.artifactHash;
    if (pinned !== undefined && sha256(content) !== pinned) {
      presenter.inform(
        `${SPINE[inputPhase].artifact} changed after ${inputPhase} was approved; ` +
          `re-run \`tackle ${inputPhase} --redo\` to regenerate and re-approve it`,
      );
      return "halted";
    }
    inputs.push({ name: inputPhase, path: SPINE[inputPhase].artifact, content });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/artifact-pinning.test.ts && pnpm test && pnpm build`
Expected: all PASS (existing suites unaffected: old states without hashes verify nothing — `pinned === undefined` skips).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/hash.ts src/workflow/types.ts src/workflow/phase.ts test/artifact-pinning.test.ts
git commit -m "Pin approved artifacts by hash; verify inputs before trusting them"
```

---

### Task 2: Claude billing detection

**Files:**
- Create: `src/adapter/claude/billing.ts`
- Test: `test/claude-billing.test.ts`

**Interfaces:**
- Produces: `detectBillingType(opts: { env: Record<string, string>; readCredentials: () => Promise<string | null> }): Promise<BillingType>` and `defaultCredentialsReader(opts: { home: string; platform?: NodeJS.Platform }): () => Promise<string | null>` from `src/adapter/claude/billing.ts`. Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/claude-billing.test.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCredentialsReader, detectBillingType } from "../src/adapter/claude/billing.js";

const subCreds = JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } });

describe("claude billing detection", () => {
  it("reports metered when an Anthropic key env var is set", async () => {
    expect(
      await detectBillingType({ env: { ANTHROPIC_API_KEY: "sk-x" }, readCredentials: async () => subCreds }),
    ).toBe("metered");
    expect(
      await detectBillingType({ env: { ANTHROPIC_AUTH_TOKEN: "t" }, readCredentials: async () => subCreds }),
    ).toBe("metered");
  });

  it("ignores empty-string key env vars", async () => {
    expect(
      await detectBillingType({ env: { ANTHROPIC_API_KEY: "" }, readCredentials: async () => subCreds }),
    ).toBe("subscription");
  });

  it("reports subscription when the credential store names a subscription type", async () => {
    expect(await detectBillingType({ env: {}, readCredentials: async () => subCreds })).toBe("subscription");
  });

  it("fails closed to unknown on missing, unreadable, or malformed credentials", async () => {
    expect(await detectBillingType({ env: {}, readCredentials: async () => null })).toBe("unknown");
    expect(
      await detectBillingType({
        env: {},
        readCredentials: async () => {
          throw new Error("keychain locked");
        },
      }),
    ).toBe("unknown");
    expect(await detectBillingType({ env: {}, readCredentials: async () => "not json" })).toBe("unknown");
    expect(await detectBillingType({ env: {}, readCredentials: async () => "{}" })).toBe("unknown");
    expect(
      await detectBillingType({
        env: {},
        readCredentials: async () => JSON.stringify({ claudeAiOauth: { subscriptionType: "" } }),
      }),
    ).toBe("unknown");
  });

  it("defaultCredentialsReader reads ~/.claude/.credentials.json on non-darwin", async () => {
    const home = await mkdtemp(join(tmpdir(), "tackle-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), subCreds);
    const read = defaultCredentialsReader({ home, platform: "linux" });
    expect(await read()).toBe(subCreds);
  });

  it("defaultCredentialsReader returns null when the file is absent (non-darwin)", async () => {
    const home = await mkdtemp(join(tmpdir(), "tackle-home-"));
    const read = defaultCredentialsReader({ home, platform: "linux" });
    expect(await read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/claude-billing.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`src/adapter/claude/billing.ts` (complete file):

```typescript
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BillingType } from "../types.js";

const execFileAsync = promisify(execFile);

const ENV_KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Subscription-before-API, fail closed. Cost fields in the -p result are NOT a
 * billing signal (subscription runs still report total_cost_usd); the credential
 * store's claudeAiOauth.subscriptionType is the probe (verified live 2026-07-02).
 */
export async function detectBillingType(opts: {
  env: Record<string, string>;
  readCredentials: () => Promise<string | null>;
}): Promise<BillingType> {
  if (ENV_KEY_NAMES.some((k) => (opts.env[k] ?? "") !== "")) return "metered";

  let raw: string | null;
  try {
    raw = await opts.readCredentials();
  } catch {
    return "unknown";
  }
  if (raw === null) return "unknown";

  let subscriptionType: unknown;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { subscriptionType?: unknown } };
    subscriptionType = parsed.claudeAiOauth?.subscriptionType;
  } catch {
    return "unknown";
  }
  return typeof subscriptionType === "string" && subscriptionType !== "" ? "subscription" : "unknown";
}

/** macOS keeps Claude Code credentials in the Keychain; elsewhere it's a dotfile. */
export function defaultCredentialsReader(opts: {
  home: string;
  platform?: NodeJS.Platform;
}): () => Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    return async () => {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ]);
        return stdout.trim().length > 0 ? stdout : null;
      } catch {
        return null;
      }
    };
  }
  return async () => {
    try {
      return await readFile(join(opts.home, ".claude", ".credentials.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/claude-billing.test.ts && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/claude/billing.ts test/claude-billing.test.ts
git commit -m "Detect Claude billing from the credential store, fail closed"
```

---

### Task 3: Claude command builder and result parser

**Files:**
- Create: `src/adapter/claude/command.ts`, `src/adapter/claude/result.ts`
- Test: `test/claude-command.test.ts`

**Interfaces:**
- Produces: `buildPrintCommand(req: { prompt: string; effort: Effort; model?: string }): { cmd: string; args: string[]; stdin: string }` from `command.ts`; `parseResultJson(stdout: string): { status: TurnStatus; summary: string; sessionId: string | null; usage: TokenUsage | null }` from `result.ts`. Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/claude-command.test.ts
import { describe, expect, it } from "vitest";
import { buildPrintCommand } from "../src/adapter/claude/command.js";
import { parseResultJson } from "../src/adapter/claude/result.js";

const okResult = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "looks good",
  session_id: "s-123",
  usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
});

describe("claude print command", () => {
  it("builds a locked-down one-shot invocation with the prompt on stdin", () => {
    const c = buildPrintCommand({ prompt: "review this", effort: "high" });
    expect(c.cmd).toBe("claude");
    expect(c.stdin).toBe("review this");
    expect(c.args).toContain("-p");
    expect(c.args).toContain("--strict-mcp-config");
    const src = c.args.indexOf("--setting-sources");
    expect(c.args[src + 1]).toBe("");
    const eff = c.args.indexOf("--effort");
    expect(c.args[eff + 1]).toBe("high");
    const dis = c.args.indexOf("--disallowedTools");
    for (const tool of ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "Task", "WebFetch", "WebSearch", "NotebookEdit"]) {
      expect(c.args[dis + 1]).toContain(tool);
    }
    expect(c.args).not.toContain("--model");
  });

  it("passes a model override through", () => {
    const c = buildPrintCommand({ prompt: "p", effort: "low", model: "claude-opus-4-8" });
    const m = c.args.indexOf("--model");
    expect(c.args[m + 1]).toBe("claude-opus-4-8");
  });
});

describe("claude result parsing", () => {
  it("maps a success result to a completed turn", () => {
    const r = parseResultJson(okResult);
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("looks good");
    expect(r.sessionId).toBe("s-123");
    expect(r.usage).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 5,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    });
  });

  it("maps is_error and non-success subtypes to tool_error", () => {
    expect(parseResultJson(okResult.replace('"is_error":false', '"is_error":true')).status).toBe("tool_error");
    expect(parseResultJson(okResult.replace('"success"', '"error_max_turns"')).status).toBe("tool_error");
  });

  it("maps unparseable or wrong-shaped stdout to tool_error with no usage", () => {
    for (const bad of ["", "not json", JSON.stringify({ type: "banana" })]) {
      const r = parseResultJson(bad);
      expect(r.status).toBe("tool_error");
      expect(r.usage).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/claude-command.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

`src/adapter/claude/command.ts` (complete file):

```typescript
import type { Effort } from "../types.js";

export interface PrintCommand {
  cmd: string;
  args: string[];
  stdin: string;
}

// The reviewer needs no tools: the diff and requirement are inlined in the
// prompt, and the repo holds artifacts it must not see (.tackle/plan.md — the
// SPEC isolation rule withholds the author's plan from the reviewer).
const DISALLOWED_TOOLS = "Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,Task,WebFetch,WebSearch";

export function buildPrintCommand(req: { prompt: string; effort: Effort; model?: string }): PrintCommand {
  const args = [
    "-p",
    "--output-format",
    "json",
    // no user/project settings: no hooks, plugins, or apiKeyHelper in the review path
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disallowedTools",
    DISALLOWED_TOOLS,
    "--effort",
    req.effort,
  ];
  if (req.model !== undefined) args.push("--model", req.model);
  // prompt via stdin: argv has a ~128KB limit, review prompts embed whole diffs
  return { cmd: "claude", args, stdin: req.prompt };
}
```

`src/adapter/claude/result.ts` (complete file):

```typescript
import type { TokenUsage, TurnStatus } from "../types.js";

export interface ClaudeResult {
  status: TurnStatus;
  summary: string;
  sessionId: string | null;
  usage: TokenUsage | null;
}

const FAILED: ClaudeResult = { status: "tool_error", summary: "", sessionId: null, usage: null };

/** claude -p --output-format json prints exactly one JSON object on stdout. */
export function parseResultJson(stdout: string): ClaudeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return FAILED;
  }
  if (typeof raw !== "object" || raw === null) return FAILED;
  const r = raw as {
    type?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; output_tokens?: unknown };
  };
  if (r.type !== "result") return FAILED;

  const usage: TokenUsage | null =
    typeof r.usage === "object" && r.usage !== null
      ? {
          inputTokens: typeof r.usage.input_tokens === "number" ? r.usage.input_tokens : 0,
          cacheReadInputTokens:
            typeof r.usage.cache_read_input_tokens === "number" ? r.usage.cache_read_input_tokens : 0,
          outputTokens: typeof r.usage.output_tokens === "number" ? r.usage.output_tokens : 0,
          reasoningOutputTokens: 0,
        }
      : null;

  return {
    status: r.is_error === false && r.subtype === "success" ? "completed" : "tool_error",
    summary: typeof r.result === "string" ? r.result : "",
    sessionId: typeof r.session_id === "string" ? r.session_id : null,
    usage,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/claude-command.test.ts && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/claude/command.ts src/adapter/claude/result.ts test/claude-command.test.ts
git commit -m "Build locked-down claude print commands and parse their results"
```

---

### Task 4: ClaudeAdapter + scripted fake CLI

**Files:**
- Create: `src/adapter/claude/index.ts`, `test/fakes/claude` (executable)
- Test: `test/claude-adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 exports; `buildAdapterEnv`, `runCommand`, `captureWorkdirDiff`, `resolveHead`.
- Produces: `class ClaudeAdapter implements Adapter` with `readonly name = "claude-code"` and `constructor(opts?: { baseEnv?: Record<string, string | undefined>; readCredentials?: () => Promise<string | null> })`. Tasks 7 and 9 consume it.
- Fake knobs: `$HOME/.fake-claude.json` — `{ result?: object, exitCode?: number, promptFile?: string, writeFile?: { path: string, content: string }, sleepMs?: number }`.

- [ ] **Step 1: Write the fake CLI**

`test/fakes/claude` (complete file; `chmod +x` it):

```javascript
#!/usr/bin/env node
// Fake claude CLI: consumes stdin, prints one JSON result, exits per $HOME/.fake-claude.json knobs.
const fs = require("node:fs");
const path = require("node:path");

let knobs = {};
try {
  knobs = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".fake-claude.json"), "utf8"));
} catch {}

let stdin = "";
process.stdin.on("data", (d) => {
  stdin += d;
});
process.stdin.on("end", () => {
  if (knobs.promptFile) fs.writeFileSync(knobs.promptFile, stdin);
  if (knobs.writeFile) fs.writeFileSync(knobs.writeFile.path, knobs.writeFile.content);
  const result = knobs.result ?? {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: "fake-claude-session",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  setTimeout(() => process.exit(knobs.exitCode ?? 0), knobs.sleepMs ?? 0);
});
```

Run: `chmod +x test/fakes/claude`

- [ ] **Step 2: Write the failing tests**

Follow the structure of `test/codex-adapter.test.ts` (read it first; reuse its helpers for building a temp `HOME`, a temp git repo, and a `PATH` pointing at `test/fakes/`). The must-have cases:

```typescript
// test/claude-adapter.test.ts — key assertions (adapt setup from codex-adapter.test.ts)
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapter/claude/index.js";

// setup helper per codex-adapter.test.ts: temp git repo with an initial commit,
// temp HOME containing .fake-claude.json, env = { PATH: fakesDirFirstPath, HOME: tempHome }

describe("ClaudeAdapter", () => {
  it("runs a turn and maps the result", async () => {
    // knobs: default result
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const result = await adapter.run({ prompt: "review", workdir: repo, effort: "medium" });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("ok");
    expect(result.sessionId).toBe("fake-claude-session");
    expect(result.authorship).toEqual({ adapter: "claude-code", model: null, effort: "medium" });
    expect(result.usage.billingType).toBe("subscription");
    expect(result.workdirDiff).toBe(""); // reviewer wrote nothing
    // transcript landed on disk
    expect(result.transcriptRef).toContain(".tackle/transcripts/");
  });

  it("sends the prompt via stdin", async () => {
    // knobs: { promptFile: <temp path> } — assert its content equals the prompt after run
  });

  it("reports unknown billing without blocking the turn (the runner gates)", async () => {
    // ANTHROPIC key must NOT be in env (buildAdapterEnv bans it) — simulate via
    // readCredentials: async () => null  →  billingType "unknown"
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => null });
    const result = await adapter.run({ prompt: "p", workdir: repo, effort: "low" });
    expect(result.usage.billingType).toBe("unknown");
  });

  it("maps a nonzero exit to tool_error", async () => {
    // knobs: { exitCode: 3 }
  });

  it("captures a diff when the subprocess writes to the tree", async () => {
    // knobs: { writeFile: { path: join(repo, "sneaky.ts"), content: "x" } }
    // expect(result.workdirDiff).toContain("sneaky.ts")  — Task 7's purity check consumes this
  });

  it("times out a hung subprocess", async () => {
    // knobs: { sleepMs: 60000 }; run with timeoutMs: 500; expect status "timeout"
    // pass streamGraceMs consideration: runCommand kills with SIGKILL on timeout
  });
});
```

Write these fully, mirroring the codex adapter test's exact setup helpers (temp HOME, PATH override, git init with an initial commit — copy the pattern, don't invent a new one).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/claude-adapter.test.ts`
Expected: FAIL — `src/adapter/claude/index.js` does not exist.

- [ ] **Step 4: Implement**

`src/adapter/claude/index.ts` (complete file):

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureWorkdirDiff, resolveHead } from "../diff.js";
import { buildAdapterEnv } from "../env.js";
import { runCommand } from "../exec.js";
import type { Adapter, TurnRequest, TurnResult } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { defaultCredentialsReader, detectBillingType } from "./billing.js";
import { buildPrintCommand } from "./command.js";
import { parseResultJson } from "./result.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export class ClaudeAdapter implements Adapter {
  readonly name = "claude-code";
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly readCredentials?: () => Promise<string | null>;

  constructor(
    opts: { baseEnv?: Record<string, string | undefined>; readCredentials?: () => Promise<string | null> } = {},
  ) {
    this.baseEnv = opts.baseEnv ?? process.env;
    this.readCredentials = opts.readCredentials;
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    // USER is required on macOS: claude resolves its Keychain credentials from it
    // (without it the CLI reports "Not logged in"). Verified by live bisect.
    const env = buildAdapterEnv({ base: this.baseEnv, allow: ["PATH", "HOME", "USER"] });
    const home = env.HOME ?? homedir();
    const billingType = await detectBillingType({
      env,
      readCredentials: this.readCredentials ?? defaultCredentialsReader({ home }),
    });
    const baseRef = await resolveHead(req.workdir);
    const command = buildPrintCommand({
      prompt: req.prompt,
      effort: req.effort,
      ...(req.model === undefined ? {} : { model: req.model }),
    });

    const exec = await runCommand({
      cmd: command.cmd,
      args: command.args,
      stdin: command.stdin,
      cwd: req.workdir,
      env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const parsed = parseResultJson(exec.stdout);

    // Same ordering rationale as CodexAdapter: transcript must land even if
    // diff capture fails, so defer any diff error until after the write.
    let workdirDiff = "";
    let diffError: unknown;
    try {
      workdirDiff = await captureWorkdirDiff(req.workdir, baseRef);
    } catch (err) {
      diffError = err;
    }

    const transcriptDir = join(req.workdir, ".tackle", "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptRef = join(
      transcriptDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-claude.json`,
    );
    await writeFile(transcriptRef, exec.stdout);

    if (diffError !== undefined) throw diffError;

    let status: TurnResult["status"];
    if (exec.timedOut) status = "timeout";
    else if (exec.exitCode !== 0) status = "tool_error";
    else status = parsed.status;

    return {
      status,
      workdirDiff,
      transcriptRef,
      summary: parsed.summary,
      sessionId: parsed.sessionId,
      authorship: { adapter: this.name, model: req.model ?? null, effort: req.effort },
      usage: { tokens: parsed.usage ?? EMPTY_USAGE, billingType },
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/claude-adapter.test.ts && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapter/claude/index.ts test/fakes/claude test/claude-adapter.test.ts
git commit -m "Add the minimal Claude Code reviewer adapter"
```

---

### Task 5: The spine grows a review phase

**Files:**
- Modify: `src/workflow/types.ts` (PhaseName), `src/workflow/spine.ts`, `src/workflow/prompts.ts`, `src/workflow/phase.ts`
- Test: extend `test/spine.test.ts`; adjust `test/spine-e2e.test.ts`, `test/cli-phases.test.ts` (whatever asserts pr-after-build)

**Interfaces:**
- Produces: `PhaseName` includes `"review"`; `PHASE_ORDER = ["specs", "plan", "build", "review", "pr"]`; `SPINE.review = { name: "review", artifact: ".tackle/review.md", questionsFile: ".tackle/review-questions.md", inputs: [], predecessor: "build", entryFlag: null }`; `SPINE.pr.predecessor === "review"`. `runPhase` throws if called with `phase: "review"`. Tasks 7–9 rely on these.
- Interim behavior (until Task 9): `tackle pr` halts with "review phase is not complete; run \`tackle review\` first".

- [ ] **Step 1: Write the failing tests** — add to `test/spine.test.ts`:

```typescript
it("places review between build and pr", () => {
  expect(PHASE_ORDER).toEqual(["specs", "plan", "build", "review", "pr"]);
  expect(SPINE.review.predecessor).toBe("build");
  expect(SPINE.pr.predecessor).toBe("review");
  expect(SPINE.review.entryFlag).toBeNull();
});

it("review is always required, whatever the entry point", () => {
  for (const entry of ["specs", "plan", "build"] as const) {
    expect(effectivePredecessor("pr", entry)).toBe("review");
    expect(effectivePredecessor("review", entry)).toBe("build");
  }
});
```

And to `test/phase.test.ts`:

```typescript
it("refuses to run the review phase through runPhase", async () => {
  const dir = await tempWorkdir();
  await expect(
    runPhase({ phase: "review", workdir: dir, adapter: scriptedAdapter([async () => fakeTurn()]), presenter: approveAll, canEnter: false }),
  ).rejects.toThrow(/runReviewPhase/);
});

it("does not re-present review's pending gate from pr (review owns its commit)", async () => {
  // seed a state via helpers: build approved, review awaiting_approval, then run pr
  // expect outcome "halted" and a message containing "run `tackle review`"
});
```

Write the second test fully: seed `.tackle/workflow.json` by running specs/plan/build with `writesArtifact` fakes and `approveAll`, then hand-edit the state JSON to add `review: { status: "awaiting_approval" }`, then run pr with `capturingPresenter(true)` and assert the halt.

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run test/spine.test.ts test/phase.test.ts`
Expected: FAIL — review not in the table; type errors on `"review"`.

- [ ] **Step 3: Implement**

`src/workflow/types.ts`:

```typescript
export type PhaseName = "specs" | "plan" | "build" | "review" | "pr";
```

`src/workflow/spine.ts` — update `PHASE_ORDER` and the table:

```typescript
export const PHASE_ORDER: PhaseName[] = ["specs", "plan", "build", "review", "pr"];
```

```typescript
  review: {
    name: "review",
    artifact: ".tackle/review.md",
    // unused by the review runner (review never asks clarifying questions);
    // present because PhaseDef requires it and the invalidation loop removes it.
    questionsFile: ".tackle/review-questions.md",
    // the review runner assembles its own inputs (frozen diff + spec), so none here
    inputs: [],
    predecessor: "build",
    entryFlag: null,
  },
```

and `pr` gets `predecessor: "review"`.

`src/workflow/prompts.ts` — review never uses turn prompts; exclude it from the instruction table and guard:

```typescript
export type TurnPhase = Exclude<PhaseName, "review">;

const PHASE_INSTRUCTIONS: Record<TurnPhase, (def: PhaseDef) => string> = {
  // ... existing four entries unchanged ...
};

export function buildPhasePrompt(opts: PromptOptions): string {
  const { def } = opts;
  if (def.name === "review") throw new Error("the review phase runs through runReviewPhase, not turn prompts");
  const sections: string[] = [
    PHASE_INSTRUCTIONS[def.name](def),
    // ... rest unchanged ...
```

`src/workflow/phase.ts` — two edits:

(a) Guard at the top of `runPhase`:

```typescript
  if (opts.phase === "review") {
    throw new Error("the review phase runs through runReviewPhase, not runPhase");
  }
```

(b) In the predecessor gate, review's pending approval is never re-presented generically — approving review triggers the commit chain, which only `runReviewPhase` owns:

```typescript
    if (predState.status === "awaiting_approval") {
      if (pred === "review") {
        presenter.inform(`review is awaiting approval; run \`tackle review\` to approve and commit`);
        return "halted";
      }
      const ok = await presentGate(pred, state, opts);
      if (!ok) return "rejected";
    }
```

- [ ] **Step 4: Fix the tests the new phase breaks**

Run: `pnpm test` and fix every failure that is an *expectation* problem, not a code problem. Known ones: `test/spine-e2e.test.ts` runs `pr` right after `build` — change the first e2e to stop after `build` and assert that `pr` now halts (Task 9 restores the full run):

```typescript
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBe(1); // review is not complete yet
```

and drop `"pr"` from its approved-phases loop for now. Check `test/cli-phases.test.ts` and `test/cli.test.ts` for similar pr-after-build assumptions.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "Insert the review phase between build and pr in the spine"
```

---

### Task 6: Verdict parser and review/fix prompts

**Files:**
- Create: `src/workflow/verdict.ts`
- Modify: `src/workflow/prompts.ts` (append two builders)
- Test: `test/verdict.test.ts`, extend `test/prompts.test.ts`

**Interfaces:**
- Produces from `verdict.ts`: `interface Finding { severity: "blocking" | "note"; file: string; line?: number; summary: string; detail?: string }`, `interface Verdict { verdict: "clean" | "findings"; findings: Finding[] }`, `parseVerdict(text: string): Verdict | null`, `blockingFindings(v: Verdict): Finding[]`.
- Produces from `prompts.ts`: `buildReviewPrompt(opts: { diff: string; requirement: { label: string; content: string } }): string`, `buildFixPrompt(opts: { findings: Finding[]; request: string }): string`. Task 7 consumes all of these.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/verdict.test.ts
import { describe, expect, it } from "vitest";
import { blockingFindings, parseVerdict } from "../src/workflow/verdict.js";

const wrap = (json: string) => "Review complete.\n\n```json\n" + json + "\n```\n";

describe("parseVerdict", () => {
  it("parses a clean verdict", () => {
    const v = parseVerdict(wrap('{ "verdict": "clean", "findings": [] }'));
    expect(v).toEqual({ verdict: "clean", findings: [] });
  });

  it("parses findings with optional fields", () => {
    const v = parseVerdict(
      wrap(
        '{ "verdict": "findings", "findings": [' +
          '{ "severity": "blocking", "file": "src/a.ts", "line": 3, "summary": "bug", "detail": "why" },' +
          '{ "severity": "note", "file": "src/b.ts", "summary": "style" }] }',
      ),
    );
    expect(v?.findings).toHaveLength(2);
    expect(blockingFindings(v!)).toHaveLength(1);
    expect(v?.findings[0]).toEqual({ severity: "blocking", file: "src/a.ts", line: 3, summary: "bug", detail: "why" });
  });

  it("uses the LAST fenced json block (models sometimes quote the format first)", () => {
    const text = wrap('{ "verdict": "findings", "findings": [] }') + wrap('{ "verdict": "clean", "findings": [] }');
    expect(parseVerdict(text)?.verdict).toBe("clean");
  });

  it("returns null on missing block, bad json, or bad shape", () => {
    expect(parseVerdict("no block here")).toBeNull();
    expect(parseVerdict(wrap("not json"))).toBeNull();
    expect(parseVerdict(wrap('{ "verdict": "maybe", "findings": [] }'))).toBeNull();
    expect(parseVerdict(wrap('{ "verdict": "clean", "findings": [{ "severity": "huge" }] }'))).toBeNull();
  });
});
```

Add to `test/prompts.test.ts`:

```typescript
import { buildFixPrompt, buildReviewPrompt } from "../src/workflow/prompts.js";

describe("review prompts", () => {
  it("inlines the diff and requirement, demands the verdict block, forbids writes", () => {
    const p = buildReviewPrompt({ diff: "+added line", requirement: { label: "specs (.tackle/specs.md)", content: "must render" } });
    expect(p).toContain("+added line");
    expect(p).toContain("must render");
    expect(p).toContain('"verdict"');
    expect(p).toContain("Do not modify any files");
    expect(p).toContain("simplifications"); // structural posture
  });

  it("fix prompt lists findings and forbids committing", () => {
    const p = buildFixPrompt({
      findings: [{ severity: "blocking", file: "src/a.ts", line: 3, summary: "off by one", detail: "loop bound" }],
      request: "add widget",
    });
    expect(p).toContain("src/a.ts:3");
    expect(p).toContain("off by one");
    expect(p).toContain("Do not commit");
    expect(p).toContain("add widget");
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run test/verdict.test.ts test/prompts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/workflow/verdict.ts` (complete file):

```typescript
export interface Finding {
  severity: "blocking" | "note";
  file: string;
  line?: number;
  summary: string;
  detail?: string;
}

export interface Verdict {
  verdict: "clean" | "findings";
  findings: Finding[];
}

/** Only blocking findings drive the fix loop; notes are recorded, never gating. */
export function blockingFindings(v: Verdict): Finding[] {
  return v.findings.filter((f) => f.severity === "blocking");
}

/**
 * Extract the LAST fenced ```json block — the prompt instructs the reviewer to
 * end with it, and earlier blocks may be the reviewer quoting the format back.
 * null = the gate could not read its measurement; the caller fails closed.
 */
export function parseVerdict(text: string): Verdict | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const verdict = (raw as { verdict?: unknown }).verdict;
  if (verdict !== "clean" && verdict !== "findings") return null;
  const rawFindings = (raw as { findings?: unknown }).findings ?? [];
  if (!Array.isArray(rawFindings)) return null;

  const findings: Finding[] = [];
  for (const f of rawFindings) {
    if (typeof f !== "object" || f === null) return null;
    const { severity, file, line, summary, detail } = f as Record<string, unknown>;
    if (severity !== "blocking" && severity !== "note") return null;
    if (typeof file !== "string" || typeof summary !== "string") return null;
    findings.push({
      severity,
      file,
      summary,
      ...(typeof line === "number" ? { line } : {}),
      ...(typeof detail === "string" ? { detail } : {}),
    });
  }
  return { verdict, findings };
}
```

Append to `src/workflow/prompts.ts`:

```typescript
import type { Finding } from "./verdict.js";

export function buildReviewPrompt(opts: {
  diff: string;
  requirement: { label: string; content: string };
}): string {
  return [
    `You are the cross-model review gate of a phase-gated development workflow. Review the diff ` +
      `below — the complete, frozen output of a build phase — against the requirement that follows. ` +
      `You have no tools; everything you need is in this prompt. Do not modify any files.`,
    `Report as "blocking" severity: correctness bugs; the diff not implementing the requirement; ` +
      `missed simplifications — could the change be reframed so whole branches disappear?; and ` +
      `structural explosions — a file crossing roughly 1,000 lines is a finding, not a shrug. ` +
      `Report genuine but non-gating improvements as "note" severity.`,
    `End your reply with exactly one fenced json block in this shape:\n\n` +
      "```json\n" +
      `{ "verdict": "clean", "findings": [{ "severity": "blocking", "file": "path/to/file.ts", ` +
      `"line": 123, "summary": "one line", "detail": "why, and what to do instead" }] }\n` +
      "```\n\n" +
      `Use verdict "clean" only when there are no blocking findings; otherwise use "findings". ` +
      `"line" and "detail" are optional.`,
    `## Requirement: ${opts.requirement.label}\n\n${opts.requirement.content}`,
    `## Diff under review\n\n\`\`\`diff\n${opts.diff}\n\`\`\``,
  ].join("\n\n");
}

export function buildFixPrompt(opts: { findings: Finding[]; request: string }): string {
  const list = opts.findings
    .map(
      (f) =>
        `- ${f.file}${f.line === undefined ? "" : `:${f.line}`} — ${f.summary}` +
        (f.detail === undefined ? "" : `\n  ${f.detail}`),
    )
    .join("\n");
  return [
    `You are running a fix turn in the review phase of a phase-gated development workflow. A ` +
      `cross-model review of the uncommitted changes in this repository found blocking findings. ` +
      `Fix all of them in the working tree. Do not commit; leave every change uncommitted — the ` +
      `harness re-freezes the diff and re-reviews it. Do not weaken or delete tests to satisfy a finding.`,
    `## Original request\n\n${opts.request}`,
    `## Blocking findings\n\n${list}`,
  ].join("\n\n");
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/verdict.test.ts test/prompts.test.ts && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/verdict.ts src/workflow/prompts.ts test/verdict.test.ts test/prompts.test.ts
git commit -m "Parse reviewer verdicts; add review and fix prompts"
```

---

### Task 7: runReviewPhase — guards, clean path, commit chain

**Files:**
- Create: `src/workflow/review.ts`
- Modify: `src/adapter/diff.ts` (export the `git` helper)
- Modify: `test/helpers/workflow.ts` (git-repo helper)
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: `presentGate`/`toTurnRecord` (Task 1), SPINE review entry (Task 5), `parseVerdict`/`blockingFindings`/`buildReviewPrompt` (Task 6), `sha256`, `captureWorkdirDiff`, `resolveHead`, `loadPolicyConfig`.
- Produces: `runReviewPhase(opts: RunReviewOptions): Promise<PhaseOutcome>` where `RunReviewOptions = { workdir: string; reviewer: Adapter; author: Adapter; presenter: Presenter; redo?: boolean; effort?: Effort; model?: string; timeoutMs?: number }`. `PhaseState` gains `reviewedDiffHash?: string` and `commitSha?: string`. Exported `git(workdir, args): Promise<string>` from `diff.ts`. Task 8 extends the loop; Task 9 wires the CLI.
- In this task, ANY blocking findings escalate straight to the human gate (the fix loop arrives in Task 8) — a working subset, and the escalation path Task 8 reuses.

- [ ] **Step 1: Export `git` from `src/adapter/diff.ts`** — add `export` to the existing private `git` function; run `pnpm test` to confirm nothing broke.

- [ ] **Step 2: Add a git-repo helper to `test/helpers/workflow.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout;
}

/** Temp git repo with identity configured, .tackle/ ignored, and one initial commit. */
export async function tempGitRepo(): Promise<string> {
  const dir = await tempWorkdir();
  await gitIn(dir, ["init", "-q"]);
  await gitIn(dir, ["config", "user.name", "tackle-test"]);
  await gitIn(dir, ["config", "user.email", "tackle-test@local"]);
  await writeFile(join(dir, ".gitignore"), ".tackle/\n");
  await gitIn(dir, ["add", ".gitignore"]);
  await gitIn(dir, ["commit", "-qm", "init"]);
  return dir;
}
```

Give the existing `scriptedAdapter` an optional adapter name so the cross-model
gate (which compares `reviewer.name` against the recorded build author) can be
exercised for real: `scriptedAdapter(behaviors, name = "fake")` returning
`{ name, prompts, run }`. Existing callers are unaffected.

Also add a state-seeding helper so review tests don't re-run the whole spine:

```typescript
import { writeWorkflowState } from "../../src/workflow/state.js";
import { sha256 } from "../../src/workflow/hash.js";
import type { WorkflowState } from "../../src/workflow/types.js";

/**
 * Seed a repo as if build just got approved: writes a tree change, freezes its
 * real diff to .tackle/build.diff, and writes an approved-build workflow state.
 * Returns the frozen diff.
 */
export async function seedApprovedBuild(
  dir: string,
  opts: { authorAdapter?: string; request?: string; specs?: string } = {},
): Promise<string> {
  const { captureWorkdirDiff, resolveHead } = await import("../../src/adapter/diff.js");
  await writeFile(join(dir, "w.ts"), "export const w = 1;\n");
  const diff = await captureWorkdirDiff(dir, await resolveHead(dir));
  await mkdir(join(dir, ".tackle"), { recursive: true });
  await writeFile(join(dir, ".tackle", "build.diff"), diff);
  const state: WorkflowState = {
    version: 1,
    request: opts.request ?? "add widget",
    entry: opts.specs === undefined ? "build" : "specs",
    phases: {
      build: {
        status: "approved",
        diffHash: sha256(diff),
        lastTurn: {
          status: "completed",
          summary: "built it",
          authorship: { adapter: opts.authorAdapter ?? "codex", model: null, effort: "medium" },
          billingType: "subscription",
          transcriptRef: "/tmp/t.jsonl",
          sessionId: null,
        },
      },
    },
  };
  if (opts.specs !== undefined) {
    await writeFile(join(dir, ".tackle", "specs.md"), opts.specs);
    state.phases.specs = { status: "approved", artifactHash: sha256(opts.specs) };
    state.phases.plan = { status: "approved" };
  }
  await writeWorkflowState(dir, state);
  return diff;
}
```

(`seedApprovedBuild` with `specs` also marks plan approved so the state is internally consistent.)

- [ ] **Step 3: Write the failing tests**

```typescript
// test/review.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runReviewPhase } from "../src/workflow/review.js";
import { sha256 } from "../src/workflow/hash.js";
import {
  approveAll,
  capturingPresenter,
  fakeTurn,
  rejectAll,
  scriptedAdapter,
  seedApprovedBuild,
  tempGitRepo,
} from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const FINDINGS =
  'issues\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "bad" }] }\n```\n';

/** Reviewer fake: echoes the tree's current diff back (a pure, non-writing reviewer). */
function reviewerSaying(summary: string, diff: string) {
  return scriptedAdapter([async () => fakeTurn({ summary, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } })]);
}
const unusedAuthor = () => scriptedAdapter([async () => fakeTurn()]);

async function readState(dir: string) {
  return JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
}

describe("runReviewPhase: clean path and commit chain", () => {
  it("clean verdict -> gate -> commit; state records the sha and review.md exists", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const state = await readState(dir);
    expect(state.phases.review.status).toBe("approved");
    expect(state.phases.review.reviewedDiffHash).toBe(sha256(diff));
    expect(state.phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dir, ".tackle", "review.md"), "utf8")).toContain("clean");
    // the commit actually exists and contains the change, not .tackle
    const { git } = await import("../src/adapter/diff.js");
    const show = await git(dir, ["show", "--stat", "HEAD"]);
    expect(show).toContain("w.ts");
    expect(show).not.toContain(".tackle");
    // tree is clean afterwards
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("rejecting the gate does not commit", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll,
    });
    expect(outcome).toBe("rejected");
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["log", "--oneline"])).not.toContain("add widget");
  });

  it("verifies specs against its pinned hash before reviewing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir, { specs: "# real specs\n" });
    await writeFile(join(dir, ".tackle", "specs.md"), "# tampered\n");
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed after specs was approved");
  });

  it("halts on drift: the tree no longer matches the frozen diff", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await writeFile(join(dir, "w.ts"), "export const w = 2;\n"); // tree drifts
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed since build was approved");
  });

  it("halts on a tampered frozen diff (tree and file edited consistently)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    // consistent rewrite of tree + build.diff that no longer matches the approval pin
    const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
    await writeFile(join(dir, "w.ts"), "export const w = 666;\n");
    const evil = await captureWorkdirDiff(dir, await resolveHead(dir));
    await writeFile(join(dir, ".tackle", "build.diff"), evil);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, evil), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("does not match the hash pinned at build approval");
  });

  it("fails closed on unknown or same-runtime authorship", async () => {
    for (const authorAdapter of [undefined, "claude-code"]) {
      const dir = await tempGitRepo();
      const diff = await seedApprovedBuild(dir, authorAdapter === undefined ? {} : { authorAdapter });
      if (authorAdapter === undefined) {
        // strip the authorship record to simulate unknown
        const state = await readState(dir);
        delete state.phases.build.lastTurn;
        await writeFile(join(dir, ".tackle", "workflow.json"), JSON.stringify(state));
      }
      const presenter = capturingPresenter(true);
      // reviewer named "claude-code" so the same-runtime comparison (reviewer.name
      // vs recorded build author) actually trips in the second iteration
      const reviewer = scriptedAdapter(
        [async () => fakeTurn({ summary: CLEAN, workdirDiff: diff })],
        "claude-code",
      );
      const outcome = await runReviewPhase({ workdir: dir, reviewer, author: unusedAuthor(), presenter });
      expect(outcome).toBe("halted");
    }
  });

  it("halts when the reviewer modifies the working tree", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const impure = scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, "sneaky.ts"), "x\n");
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary: CLEAN, workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      },
    ]);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: impure, author: unusedAuthor(), presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("reviewer modified the working tree");
  });

  it("halts on non-subscription reviewer billing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const metered = scriptedAdapter([
      async () => fakeTurn({ summary: CLEAN, workdirDiff: diff, usage: { tokens: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, billingType: "metered" } }),
    ]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: metered, author: unusedAuthor(), presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
  });

  it("halts (after retry) on an unparseable verdict", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const babbler = scriptedAdapter([async () => fakeTurn({ summary: "no json here", workdirDiff: diff })]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: babbler, author: unusedAuthor(), presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
    expect(babbler.prompts.length).toBe(2); // 1 + deterministicRetries(1)
  });

  it("blocking findings escalate to the gate; approval still commits (integrity, not cleanliness)", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const state = await readState(dir);
    expect(state.phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dir, ".tackle", "review.md"), "utf8")).toContain("bad");
  });

  it("resume: a pending review gate is re-presented and commits on approval", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    // second invocation: no new reviewer turn, gate re-presented, commit happens
    const secondReviewer = scriptedAdapter([async () => { throw new Error("must not run a turn on resume"); }]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: secondReviewer, author: unusedAuthor(), presenter: approveAll });
    expect(outcome).toBe("approved");
    expect((await readState(dir)).phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("never commits .tackle, even in a repo that does not gitignore it", async () => {
    const dir = await tempGitRepo();
    const { git } = await import("../src/adapter/diff.js");
    await git(dir, ["rm", "-q", ".gitignore"]);
    await git(dir, ["commit", "-qm", "drop gitignore"]);
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const show = await git(dir, ["show", "--stat", "HEAD"]);
    expect(show).toContain("w.ts");
    expect(show).not.toContain(".tackle");
  });

  it("refuses to commit when the tree changed between review-pass and approval", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    await writeFile(join(dir, "w.ts"), "export const w = 3;\n"); // tamper post-pass
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: scriptedAdapter([async () => fakeTurn()]), author: unusedAuthor(), presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("refusing to commit");
  });
});
```

- [ ] **Step 4: Run to verify failures**

Run: `pnpm vitest run test/review.test.ts`
Expected: FAIL — `src/workflow/review.js` does not exist.

- [ ] **Step 5: Implement**

`src/workflow/types.ts` — extend `PhaseState` (final shape):

```typescript
export interface PhaseState {
  status: PhaseStatus;
  lastTurn?: TurnRecord;
  /** sha256 of the artifact file, pinned at approval time (SPEC artifact integrity). */
  artifactHash?: string;
  /** build only: sha256 of the currently frozen .tackle/build.diff (see design refinement). */
  diffHash?: string;
  /** review only: sha256 of the diff the reviewer passed; the commit chain's precondition. */
  reviewedDiffHash?: string;
  /** review only: the commit created on review approval. */
  commitSha?: string;
}
```

`src/workflow/review.ts` (complete file):

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureWorkdirDiff, git, resolveHead } from "../adapter/diff.js";
import type { Adapter, Effort, TurnResult } from "../adapter/types.js";
import { readArtifact, removeArtifact } from "./artifacts.js";
import { sha256 } from "./hash.js";
import type { PhaseOutcome } from "./phase.js";
import { presentGate, toTurnRecord } from "./phase.js";
import type { Presenter } from "./presenter.js";
import { buildReviewPrompt } from "./prompts.js";
import { BUILD_DIFF_FILE, SPINE } from "./spine.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "./state.js";
import type { PolicyConfig, WorkflowState } from "./types.js";
import type { Verdict } from "./verdict.js";
import { blockingFindings, parseVerdict } from "./verdict.js";

export interface RunReviewOptions {
  workdir: string;
  reviewer: Adapter;
  author: Adapter;
  presenter: Presenter;
  redo?: boolean;
  effort?: Effort;
  model?: string;
  timeoutMs?: number;
}

interface RoundRecord {
  round: number;
  verdict: Verdict;
  fixSummary?: string;
}

function renderReviewMd(rounds: RoundRecord[], escalation?: string): string {
  const parts = ["# Review record", ""];
  for (const r of rounds) {
    parts.push(`## Round ${r.round}: ${r.verdict.verdict}`, "");
    for (const f of r.verdict.findings) {
      parts.push(
        `- **${f.severity}** ${f.file}${f.line === undefined ? "" : `:${f.line}`} — ${f.summary}` +
          (f.detail === undefined ? "" : `\n  ${f.detail}`),
      );
    }
    if (r.verdict.findings.length === 0) parts.push("- no findings");
    if (r.fixSummary !== undefined) parts.push("", `Fix turn: ${r.fixSummary}`);
    parts.push("");
  }
  if (escalation !== undefined) parts.push(`## Escalated to human gate`, "", escalation, "");
  return parts.join("\n");
}

function commitMessage(state: WorkflowState): string {
  const firstLine = state.request.split("\n")[0] ?? state.request;
  const subject = firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
  const body = state.phases.build?.lastTurn?.summary ?? "";
  return body.length > 0 ? `${subject}\n\n${body}\n` : `${subject}\n`;
}

/** Billing gate, same fail-closed semantics and copy as runPhase's. */
function billingHaltMessage(billingType: string): string | null {
  if (billingType === "subscription") return null;
  return billingType === "metered"
    ? "halted: turn billed metered; fix adapter auth before re-running (subscription-before-API gate)"
    : "halted: could not verify subscription billing (billing type unknown); refusing to proceed " +
        "— check the adapter's credentials (Claude Code login, or ~/.codex/auth.json for codex)";
}

async function haltReview(
  workdir: string,
  state: WorkflowState,
  lastTurn: TurnResult | null,
  presenter: Presenter,
  message: string,
): Promise<PhaseOutcome> {
  state.phases.review = {
    status: "halted",
    ...(lastTurn === null ? {} : { lastTurn: toTurnRecord(lastTurn) }),
  };
  await writeWorkflowState(workdir, state);
  presenter.inform(message);
  return "halted";
}

/**
 * The bdfinst .review-passed mechanism: nothing is committed unless the staged
 * content hashes to exactly what the reviewer passed. Runs after gate approval.
 */
async function commitReviewed(
  workdir: string,
  state: WorkflowState,
  presenter: Presenter,
): Promise<PhaseOutcome> {
  const review = state.phases.review;
  const expected = review?.reviewedDiffHash;
  if (review === undefined || expected === undefined) {
    return haltReview(workdir, state, null, presenter, "no reviewed-diff hash on record; re-run `tackle review --redo`");
  }
  const diffNow = await captureWorkdirDiff(workdir, await resolveHead(workdir));
  if (sha256(diffNow) !== expected) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      "working tree changed between review and commit; refusing to commit — re-run `tackle review --redo`",
    );
  }
  // .tackle/ is harness state, never part of the reviewed diff (captureWorkdirDiff
  // excludes it) — keep it out of staging too, so the chain holds even in repos
  // that don't gitignore it. Staged-then-unstaged rather than an exclude pathspec:
  // git exits 1 when an ignored path is named in any pathspec, even an exclude.
  await git(workdir, ["add", "-A"]);
  await git(workdir, ["reset", "-q", "HEAD", "--", ".tackle"]);
  // Belt and suspenders: everything the reviewer passed must now be staged.
  const porcelain = await git(workdir, ["status", "--porcelain"]);
  const unstaged = porcelain
    .split("\n")
    .filter((l) => l.length > 0 && !l.slice(3).startsWith(".tackle"))
    .filter((l) => l[1] !== " ");
  if (unstaged.length > 0) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `unexpected unstaged changes after staging; refusing to commit:\n${unstaged.join("\n")}`,
    );
  }
  await git(workdir, ["commit", "-m", commitMessage(state)]);
  const sha = (await git(workdir, ["rev-parse", "HEAD"])).trim();
  review.status = "approved";
  review.commitSha = sha;
  const reviewMd = await readArtifact(workdir, SPINE.review.artifact);
  if (reviewMd !== null) review.artifactHash = sha256(reviewMd);
  await writeWorkflowState(workdir, state);
  presenter.inform(`committed ${sha.slice(0, 10)}`);
  return "approved";
}

async function presentReviewGateAndCommit(
  workdir: string,
  state: WorkflowState,
  presenter: Presenter,
  detail?: string,
): Promise<PhaseOutcome> {
  const review = state.phases.review;
  if (review === undefined) throw new Error("no review state to present");
  const approved = await presenter.askApproval({
    title: "review phase awaiting approval",
    artifactPath: SPINE.review.artifact,
    summary: review.lastTurn?.summary ?? "",
    detail: detail ?? "approval stages and commits the reviewed diff",
  });
  if (!approved) return "rejected";
  return commitReviewed(workdir, state, presenter);
}

export async function runReviewPhase(opts: RunReviewOptions): Promise<PhaseOutcome> {
  const { presenter, workdir } = opts;
  const state = await readWorkflowState(workdir);
  if (state === null) {
    presenter.inform(`no workflow in progress; start one with \`tackle specs "<request>"\``);
    return "halted";
  }

  // -- predecessor: build must be complete (re-present its pending gate) -------
  const buildState = state.phases.build;
  if (buildState === undefined || buildState.status === "halted" || buildState.status === "needs_clarification") {
    presenter.inform("build phase is not complete; run `tackle build` first");
    return "halted";
  }
  if (buildState.status === "awaiting_approval") {
    const ok = await presentGate("build", state, { workdir, presenter });
    if (!ok) return "rejected";
  }

  // -- own-phase resume ---------------------------------------------------------
  const own = state.phases.review;
  if (own !== undefined && opts.redo !== true) {
    if (own.status === "approved") {
      presenter.inform("review is already approved; pass --redo to run it again");
      return "approved";
    }
    if (own.status === "awaiting_approval") {
      return presentReviewGateAndCommit(workdir, state, presenter);
    }
    // halted: fall through and re-run
  }

  // -- re-running review invalidates pr ------------------------------------------
  delete state.phases.pr;
  await removeArtifact(workdir, SPINE.pr.artifact);
  await removeArtifact(workdir, SPINE.pr.questionsFile);
  delete state.phases.review;
  await removeArtifact(workdir, SPINE.review.artifact);
  await removeArtifact(workdir, SPINE.review.questionsFile);
  await writeWorkflowState(workdir, state);

  // -- cross-model gate: fail closed on unknown or same-runtime authorship -------
  const authorAdapter = buildState.lastTurn?.authorship.adapter;
  if (authorAdapter === undefined) {
    return haltReview(workdir, state, null, presenter, "cannot establish build authorship; refusing to review (fail-closed cross-model gate)");
  }
  if (authorAdapter === opts.reviewer.name) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `reviewer runtime (${opts.reviewer.name}) matches the build author; cross-model review requires a different runtime`,
    );
  }

  // -- requirement input: hash-verified specs, else the workflow request ----------
  // An approved phase always pinned a non-blank artifact, so pin-present with the
  // file missing/blank is tamper too (blanking must not demote the requirement).
  let requirement = { label: "workflow request", content: state.request };
  const specsPinned = state.phases.specs?.artifactHash;
  const specsContent = await readArtifact(workdir, SPINE.specs.artifact);
  if (specsContent !== null) {
    if (specsPinned !== undefined && sha256(specsContent) !== specsPinned) {
      return haltReview(
        workdir,
        state,
        null,
        presenter,
        `${SPINE.specs.artifact} changed after specs was approved; re-run \`tackle specs --redo\``,
      );
    }
    requirement = { label: `specs (${SPINE.specs.artifact})`, content: specsContent };
  } else if (specsPinned !== undefined) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `${SPINE.specs.artifact} is missing or blank but specs was approved; re-run \`tackle specs --redo\``,
    );
  }

  // -- frozen diff + drift + tamper checks ----------------------------------------
  const frozen = await readArtifact(workdir, BUILD_DIFF_FILE);
  if (frozen === null) {
    return haltReview(workdir, state, null, presenter, "no frozen build diff (or it is empty); nothing to review — re-run `tackle build --redo`");
  }
  const pinnedDiff = buildState.diffHash;
  if (pinnedDiff !== undefined && sha256(frozen) !== pinnedDiff) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `${BUILD_DIFF_FILE} does not match the hash pinned at build approval; re-run \`tackle build --redo\``,
    );
  }
  const treeDiff = await captureWorkdirDiff(workdir, await resolveHead(workdir));
  if (treeDiff !== frozen) {
    return haltReview(workdir, state, null, presenter, "the working tree changed since build was approved; re-run `tackle build --redo`");
  }

  const policy = await loadPolicyConfig(workdir);
  return reviewLoop({ ...opts, state, policy, requirement, initialDiff: frozen });
}

interface LoopContext extends RunReviewOptions {
  state: WorkflowState;
  policy: PolicyConfig;
  requirement: { label: string; content: string };
  initialDiff: string;
}

/** Task 7 scope: one review round; blocking findings escalate straight to the gate. */
async function reviewLoop(ctx: LoopContext): Promise<PhaseOutcome> {
  const { presenter, state, workdir } = ctx;
  const rounds: RoundRecord[] = [];
  const currentDiff = ctx.initialDiff;

  const reviewed = await runReviewerTurn(ctx, currentDiff, rounds.length + 1);
  if ("halt" in reviewed) return reviewed.halt;
  const { result, verdict } = reviewed;
  rounds.push({ round: rounds.length + 1, verdict });

  const blocking = blockingFindings(verdict);
  const escalation =
    blocking.length === 0
      ? undefined
      : `${blocking.length} unresolved blocking finding(s); approving commits anyway, rejecting discards the review.`;
  await writeFile(join(workdir, SPINE.review.artifact), renderReviewMd(rounds, escalation));

  state.phases.review = {
    status: "awaiting_approval",
    lastTurn: toTurnRecord(result),
    reviewedDiffHash: sha256(currentDiff),
  };
  await writeWorkflowState(workdir, state);
  return presentReviewGateAndCommit(workdir, state, presenter, escalation);
}

/** One reviewer turn under the deterministic-retry policy, with purity + billing + verdict gates. */
async function runReviewerTurn(
  ctx: LoopContext,
  currentDiff: string,
  round: number,
): Promise<{ result: TurnResult; verdict: Verdict } | { halt: PhaseOutcome }> {
  const { presenter, policy, state, workdir } = ctx;
  let lastTurn: TurnResult | null = null;
  let retryNote: string | undefined;
  for (let attempt = 0; attempt <= policy.deterministicRetries; attempt++) {
    const prompt =
      buildReviewPrompt({ diff: currentDiff, requirement: ctx.requirement }) +
      (retryNote === undefined ? "" : `\n\n## Previous attempt\n\n${retryNote}`);
    const result = await ctx.reviewer.run({
      prompt,
      workdir,
      effort: ctx.effort ?? "medium",
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    lastTurn = result;

    const billingHalt = billingHaltMessage(result.usage.billingType);
    if (billingHalt !== null) return { halt: await haltReview(workdir, state, result, presenter, billingHalt) };
    if (result.workdirDiff !== currentDiff) {
      return {
        halt: await haltReview(
          workdir,
          state,
          result,
          presenter,
          "reviewer modified the working tree; inspect `git status` and clean up before re-running `tackle review`",
        ),
      };
    }
    if (result.status !== "completed") {
      retryNote = `The previous attempt ended with status "${result.status}" before finishing. Start over.`;
      continue;
    }
    const verdict = parseVerdict(result.summary);
    if (verdict === null) {
      retryNote = "The previous attempt did not end with a parseable fenced json verdict block. You must end with exactly one.";
      continue;
    }
    return { result, verdict };
  }
  return {
    halt: await haltReview(
      workdir,
      state,
      lastTurn,
      presenter,
      `review round ${round} produced no usable verdict after ${policy.deterministicRetries + 1} attempt(s)`,
    ),
  };
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run test/review.test.ts && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/review.ts src/workflow/types.ts src/adapter/diff.ts test/helpers/workflow.ts test/review.test.ts
git commit -m "Run the review phase: cross-model gate, drift checks, hash-matched commit"
```

---

### Task 8: Fix loop, budgets, circuit breaker

**Files:**
- Modify: `src/workflow/review.ts` (replace `reviewLoop`)
- Test: extend `test/review.test.ts`

**Interfaces:**
- Consumes: `buildFixPrompt` (Task 6), `billingHaltMessage`, `runReviewerTurn`, `presentReviewGateAndCommit` (Task 7).
- Produces: the final loop semantics — `reviewLoopIterations` = max fix turns; circuit breaker escalates when the same blocking findings repeat `circuitBreakerThreshold` consecutive rounds; each fix turn re-freezes `.tackle/build.diff` and updates `state.phases.build.diffHash` (custody pin).

Task 7's review left two Minors for this task to sweep:
1. A resumed escalation gate loses its "unresolved blocking findings" warning
   (resume calls `presentReviewGateAndCommit` with no detail). Fix: `PhaseState`
   gains `gateDetail?: string` (review only); `finish()` persists the escalation
   string there; the resume path passes `own.gateDetail` through.
2. The porcelain filter `l.slice(3).startsWith(".tackle")` also exempts
   `.tackleX`. Fix: `const p = l.slice(3); p === ".tackle" || p.startsWith(".tackle/")`.

- [ ] **Step 1: Write the failing tests** — add to `test/review.test.ts`:

```typescript
describe("runReviewPhase: fix loop", () => {
  const FINDINGS_A =
    'a\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "issue A" }] }\n```\n';
  const FINDINGS_B =
    'b\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "issue B" }] }\n```\n';

  /** Author fake that "fixes" by changing the tree, returning the new real diff. */
  function fixingAuthor(newContent: string) {
    return scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, "w.ts"), newContent);
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary: "fixed it", workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      },
    ]);
  }

  /** Reviewer that must recompute the live diff per round (post-fix rounds see a new tree). */
  function liveReviewer(summaries: string[]) {
    let call = 0;
    return scriptedAdapter(
      summaries.map((summary) => async (req: TurnRequest) => {
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary, workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      }),
    );
  }

  it("findings -> fix -> clean -> commit; review.md records both rounds; diff custody updates", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A, CLEAN]);
    const author = fixingAuthor("export const w = 2; // fixed\n");
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: approveAll });
    expect(outcome).toBe("approved");
    const md = await readFile(join(dir, ".tackle", "review.md"), "utf8");
    expect(md).toContain("Round 1");
    expect(md).toContain("Round 2");
    expect(md).toContain("issue A");
    // the committed content is the FIXED version
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["show", "HEAD:w.ts"])).toContain("fixed");
    // second reviewer prompt contained the re-frozen diff
    expect(reviewer.prompts[1]).toContain("fixed");
    // custody: build.diffHash matches the final frozen diff
    const state = await readState(dir);
    const frozen = await readFile(join(dir, ".tackle", "build.diff"), "utf8");
    expect(state.phases.build.diffHash).toBe(sha256(frozen));
  });

  it("escalates when the fix budget is exhausted", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    // default reviewLoopIterations = 2: rounds go A, B, A -> the circuit breaker
    // never trips (no two consecutive rounds identical) but 2 fixes are spent -> escalate
    const reviewer = liveReviewer([FINDINGS_A, FINDINGS_B, FINDINGS_A]);
    const author = fixingAuthor("export const w = 2;\n");
    const presenter = capturingPresenter(false); // human rejects the escalation
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("rejected");
    expect(reviewer.prompts.length).toBe(3);
    const md = await readFile(join(dir, ".tackle", "review.md"), "utf8");
    expect(md).toContain("Escalated");
  });

  it("circuit-breaks on identical findings two rounds running (no progress)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A, FINDINGS_A, FINDINGS_A]);
    const author = fixingAuthor("export const w = 9;\n");
    const presenter = capturingPresenter(false);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("rejected");
    // identical A twice consecutively trips threshold 2 after ONE fix, not two
    expect(reviewer.prompts.length).toBe(2);
    expect(presenter.messages.concat().join("\n") + (await readFile(join(dir, ".tackle", "review.md"), "utf8"))).toContain("no progress");
  });

  it("halts when a fix turn fails or bills metered", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A]);
    const author = scriptedAdapter([
      async () => fakeTurn({ status: "tool_error", summary: "" }),
      async () => fakeTurn({ status: "tool_error", summary: "" }),
    ]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
  });
});
```

(Import `TurnRequest` from `../src/adapter/types.js` in the test file. The `Math.random` in the budget test only varies file content between fix turns so rounds differ — it runs in test code, not product code.)

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run test/review.test.ts`
Expected: the new describe block FAILS (single-round loop never fixes).

- [ ] **Step 3: Implement** — replace `reviewLoop` in `src/workflow/review.ts`:

```typescript
async function reviewLoop(ctx: LoopContext): Promise<PhaseOutcome> {
  const { presenter, policy, state, workdir } = ctx;
  const rounds: RoundRecord[] = [];
  let currentDiff = ctx.initialDiff;
  let fixesDone = 0;
  let previousBlockingKey: string | null = null;
  let identicalStreak = 0;

  for (;;) {
    const round = rounds.length + 1;
    const reviewed = await runReviewerTurn(ctx, currentDiff, round);
    if ("halt" in reviewed) return reviewed.halt;
    const { result, verdict } = reviewed;
    rounds.push({ round, verdict });

    const blocking = blockingFindings(verdict);

    const finish = async (escalation?: string): Promise<PhaseOutcome> => {
      await writeFile(join(workdir, SPINE.review.artifact), renderReviewMd(rounds, escalation));
      state.phases.review = {
        status: "awaiting_approval",
        lastTurn: toTurnRecord(result),
        reviewedDiffHash: sha256(currentDiff),
      };
      await writeWorkflowState(workdir, state);
      return presentReviewGateAndCommit(workdir, state, presenter, escalation);
    };

    if (blocking.length === 0) return finish();

    // circuit breaker: identical blocking findings N rounds running = no progress
    const key = JSON.stringify(blocking);
    identicalStreak = key === previousBlockingKey ? identicalStreak + 1 : 1;
    previousBlockingKey = key;
    if (identicalStreak >= policy.circuitBreakerThreshold) {
      return finish(
        `review made no progress (identical findings ${identicalStreak} rounds running); ` +
          `${blocking.length} unresolved blocking finding(s); approving commits anyway, rejecting discards the review.`,
      );
    }
    if (fixesDone >= policy.reviewLoopIterations) {
      return finish(
        `review loop budget exhausted (${policy.reviewLoopIterations} fix turns); ` +
          `${blocking.length} unresolved blocking finding(s); approving commits anyway, rejecting discards the review.`,
      );
    }

    // -- fix turn (author adapter), then re-freeze the diff -----------------------
    const fix = await runFixTurn(ctx, blocking);
    if ("halt" in fix) return fix.halt;
    fixesDone += 1;
    rounds[rounds.length - 1] = { round, verdict, fixSummary: fix.result.summary };
    currentDiff = fix.result.workdirDiff;
    if (currentDiff.length === 0) presenter.inform("warning: fix turn produced an empty diff");
    await writeFile(join(workdir, BUILD_DIFF_FILE), currentDiff);
    // custody pin: build.diffHash always names the currently frozen diff, so a
    // killed loop can resume (design refinement in the plan header)
    const buildState = state.phases.build;
    if (buildState !== undefined) buildState.diffHash = sha256(currentDiff);
    await writeWorkflowState(workdir, state);
  }
}

/** One author fix turn under the deterministic-retry policy, with the billing gate. */
async function runFixTurn(
  ctx: LoopContext,
  findings: Finding[],
): Promise<{ result: TurnResult } | { halt: PhaseOutcome }> {
  const { presenter, policy, state, workdir } = ctx;
  let lastTurn: TurnResult | null = null;
  let retryNote: string | undefined;
  for (let attempt = 0; attempt <= policy.deterministicRetries; attempt++) {
    const prompt =
      buildFixPrompt({ findings, request: state.request }) +
      (retryNote === undefined ? "" : `\n\n## Previous attempt\n\n${retryNote}`);
    const result = await ctx.author.run({
      prompt,
      workdir,
      effort: ctx.effort ?? "medium",
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    lastTurn = result;
    const billingHalt = billingHaltMessage(result.usage.billingType);
    if (billingHalt !== null) return { halt: await haltReview(workdir, state, result, presenter, billingHalt) };
    if (result.status !== "completed") {
      retryNote = `The previous attempt ended with status "${result.status}" before finishing. Start over.`;
      continue;
    }
    return { result };
  }
  return {
    halt: await haltReview(
      workdir,
      state,
      lastTurn,
      presenter,
      `fix turn failed after ${policy.deterministicRetries + 1} attempt(s); needs a human decision`,
    ),
  };
}
```

Add `buildFixPrompt` to the `prompts.js` import and `Finding` to the `verdict.js` type import. Note the fix turn deliberately does NOT pass `ctx.model` — that override targets the reviewer; the author uses its backend default.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/review.test.ts && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/review.ts test/review.test.ts
git commit -m "Loop review findings through author fix turns, bounded and circuit-broken"
```

---

### Task 9: CLI wiring, status, end-to-end

**Files:**
- Modify: `src/cli.ts`
- Test: extend `test/cli-phases.test.ts`, restore + extend `test/spine-e2e.test.ts`

**Interfaces:**
- Consumes: `runReviewPhase` (Task 7), `ClaudeAdapter` (Task 4).
- Produces: `tackle review [--redo] [--cwd|--effort|--model|--timeout]`; `buildProgram` opts gain `reviewerAdapter?: Adapter`; `tackle status` prints the review commit when present.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli-phases.test.ts` (follow its existing injection pattern):

```typescript
it("review command drives runReviewPhase with reviewer and author adapters", async () => {
  // temp git repo + seedApprovedBuild, then:
  const program = buildProgram({
    adapter: unusedAuthorAdapter,           // author slot
    reviewerAdapter: cleanReviewerAdapter,  // reviewer slot (scripted, from review.test.ts patterns)
    presenter: approveAll,
    writeOut: () => {},
  });
  program.exitOverride();
  await program.parseAsync(["review", "--cwd", dir], { from: "user" });
  expect(process.exitCode).toBeUndefined();
  // state: review approved with a commitSha
});

it("status shows the review phase and its commit", async () => {
  // after the run above: parse ["status", "--cwd", dir] with a capturing writeOut
  // expect output to match /review\s+approved/ and /commit [0-9a-f]{10}/
});
```

Write these fully using `tempGitRepo`/`seedApprovedBuild` from `test/helpers/workflow.ts` and a scripted clean reviewer exactly like `test/review.test.ts`'s.

Restore the full run in `test/spine-e2e.test.ts`: the e2e temp dir becomes a `tempGitRepo()`; the build fake writes a real file (`w.ts`) and computes `workdirDiff` via `captureWorkdirDiff` (import from `src/adapter/diff.js`) so the frozen diff matches the tree; add a review-phase fake to `phasePlayingAdapter` — but review doesn't route through it, so instead pass a `reviewerAdapter` that recomputes the live diff and answers clean (the `liveReviewer` pattern). The sequence becomes:

```typescript
await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
await program.parseAsync(["build", "--cwd", dir], { from: "user" });
await program.parseAsync(["review", "--cwd", dir], { from: "user" });
await program.parseAsync(["pr", "--cwd", dir], { from: "user" });
expect(process.exitCode).toBeUndefined();
// all five phases approved; review.commitSha set; git log contains "add a widget";
// pr ran against the committed tree
```

The pr-phase fake's prompt assertions stay valid (`specs` + `build` inputs are unchanged).

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run test/cli-phases.test.ts test/spine-e2e.test.ts`
Expected: FAIL — no `review` command.

- [ ] **Step 3: Implement in `src/cli.ts`**

Extend `buildProgram`'s opts type:

```typescript
export function buildProgram(
  opts: {
    adapter?: Adapter;
    reviewerAdapter?: Adapter;
    presenter?: Presenter;
    writeOut?: (s: string) => void;
  } = {},
): Command {
```

Add the command (after `build`, before `pr`), plus imports of `runReviewPhase` and `ClaudeAdapter`:

```typescript
  withTurnOptions(
    program
      .command("review")
      .description("Cross-model review of the frozen build diff; approval commits it"),
  )
    .option("--redo", "re-run review even if it already has a verdict")
    .action(async (options: PhaseCliOptions) => {
      const outcome = await runReviewPhase({
        workdir: options.cwd,
        reviewer: opts.reviewerAdapter ?? new ClaudeAdapter(),
        author: opts.adapter ?? new CodexAdapter(),
        presenter: opts.presenter ?? new TerminalPresenter(),
        ...(options.redo === undefined ? {} : { redo: options.redo }),
        effort: options.effort,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
      });
      if (outcome !== "approved") process.exitCode = 1;
    });
```

In the `status` action, after the phase loop:

```typescript
      const commit = state.phases.review?.commitSha;
      if (commit !== undefined) writeOut(`commit ${commit.slice(0, 10)}\n`);
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm build`
Expected: PASS — 5-phase e2e green.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-phases.test.ts test/spine-e2e.test.ts
git commit -m "Wire tackle review into the CLI and the end-to-end spine"
```

---

### Task 10: Live smoke, docs, bead close

**Files:**
- Modify: `README.md` (add `tackle review` to the workflow section), `docs/plans/2026-07-02-workflow-spine-notes.md` or a new notes file `docs/plans/2026-07-02-review-gate-notes.md`

This task is run by the main session (not a subagent) because it drives real CLIs interactively.

- [ ] **Step 1: Build and link** — `pnpm build`, confirm `tackle --help` lists `review`.

- [ ] **Step 2: Live smoke** in a scratch git repo (NOT this repo):
  1. `git init` a scratch repo with an initial commit and a `.gitignore` containing `.tackle/`.
  2. `tackle build --trivial "add a hello.ts that exports a greeting string" --cwd <scratch>` — approve the gate.
  3. `tackle review --cwd <scratch>` — this runs the REAL claude CLI as reviewer against the real codex-authored diff. Verify: billing detected as subscription; the verdict parses; `review.md` written; on approval a commit lands whose content is exactly the reviewed diff; `tackle status` shows all phases and the commit.
  4. Tamper test, live: re-run with `--redo`, but edit the scratch file between the reviewer pass and the gate approval (decline the gate, edit, re-run `tackle review`) — confirm the "refusing to commit" halt fires.
- [ ] **Step 3: Write the notes file** — record what the live smoke showed (billing detection evidence, verdict quality, any prompt adjustments made), plus deferred minors discovered along the way.
- [ ] **Step 4: Docs** — README workflow section gains the review phase and one sentence on the commit chain.
- [ ] **Step 5: Close the bead**

```bash
bd close tackle-483 --reason "review phase live: cross-model gate + hash-matched commit, smoke-verified"
git add -A && git commit -m "Document the review gate; record live smoke evidence"
git push
```

---

## Self-review notes (already applied)

- Spec coverage: design §Scope items 1–3 map to Tasks 5–9 (gate), 2–4 (adapter), 1 (pinning). Escalation-approves-anyway, circuit breaker, custody transfer, reviewer purity, fail-closed billing/authorship/verdict all have explicit tests.
- The interim e2e adjustment in Task 5 is deliberate (keeps every task green) and is restored in Task 9.
- Type consistency: `RunReviewOptions.reviewer/author`, `PhaseState.reviewedDiffHash/commitSha`, `presentGate`/`toTurnRecord` exports, and `git` export are named identically across Tasks 1, 5, 7, 8, 9.
