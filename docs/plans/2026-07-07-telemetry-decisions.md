# Telemetry + decisions.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-turn cost/friction telemetry (append-only JSONL ledger + `tackle telemetry` compute-on-read report) and a persistent append-only `.tackle/decisions.md` (CLI + auto-record at the two review-gate moments).

**Architecture:** New `src/telemetry/` module: a `recordedRun()` capture function wraps `adapter.run()` at the four real-turn call sites and appends one self-contained `turn-record/v1` line to `<repo>/.tackle/telemetry/turns.jsonl`; the report reads the ledger fresh every time (forgiving reader) and prices tokens from a checked-in table with a loud `unpriced` fallback. New `src/decisions/` module: the markdown file **is** the store — parse/append with atomic writes; the review commit path auto-appends through the same code path as the CLI.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Node >= 22.5, commander, vitest, pnpm. **Zero new npm dependencies.**

**Spec:** `docs/plans/2026-07-06-telemetry-decisions-design.md` (approved).

## Global Constraints

- Zero new npm dependencies.
- All tests are model-free and spend zero tokens (fake adapters only; no live turns anywhere in the suite).
- ESM: relative imports carry the `.js` suffix (`import ... from "./ledger.js"`).
- `strict` + `noUncheckedIndexedAccess` are on — index/regex-group reads need `undefined` guards.
- Ledger is **append-only JSONL**: one `JSON.stringify(record) + "\n"` per turn via `appendFile`; no read-modify-write anywhere in the capture path.
- **Telemetry failure never fails the turn**; decision auto-record failure never un-commits. Both warn and proceed.
- **No content stored** in the ledger: no prompt, no diff body. `transcriptRef` is the pointer to full evidence.
- Full relative paths in `filesTouched` (not basenames).
- `.tackle/telemetry/` stays gitignored everywhere. This repo's `.gitignore` changes to `.tackle/*` + `!.tackle/decisions.md` (Task 11); tackle itself still never commits anything under `.tackle/`.
- decisions.md: markdown is the store, no shadow JSON; append-only (no edit/delete); atomic tmp-file + rename writes; unparseable file blocks `add` with a clear error, never guesses IDs.
- Unknown models in the report are a separate `unpriced` total naming the model — never silently $0.
- Commit messages: short plain imperative (match `git log`), no AI/assistant mentions, no trailers.
- Run tests with `npx vitest run test/<file>`; typecheck with `npx tsc --noEmit`.

## File Structure

| File | Responsibility |
|---|---|
| `src/telemetry/diffstat.ts` | `FileTouch`; `parseDiffStats(diff)` — numstat-style per-file line counts from a unified diff |
| `src/telemetry/ledger.ts` | `TurnRecordV1` type + `TURNS_FILE`; `appendTurnRecord`, `readTurnRecords` (forgiving reader) |
| `src/telemetry/record.ts` | `recordedRun(adapter, req, opts)` — the capture seam |
| `src/telemetry/pricing.ts` | `PRICING` table, `PRICING_AS_OF`, `DEFAULT_MODEL`, `resolveModelLabel`, `findPricing`, `costUsd` |
| `src/telemetry/report.ts` | `computeTelemetryReport` (pure) + `renderTelemetryReport` (text) |
| `src/decisions/store.ts` | `DecisionEntry`; `parseDecisions`, `readDecisions`, `appendDecision`, `formatDecisionId` |
| `src/cli.ts` | `tackle telemetry` command; `tackle decision add/list` group; `turn` wired through `recordedRun` |
| `src/workflow/phase.ts` | `runPhase` turn wired through `recordedRun` (`phase:<name>` context) |
| `src/workflow/review.ts` | reviewer + fix turns wired through `recordedRun`; auto-decision at commit |
| `src/workflow/types.ts` | `PhaseState` gains `reviewRounds?` and `escalatedFindings?` (review only) |
| `.gitignore` | `.tackle/` → `.tackle/*` + `!.tackle/decisions.md` |
| `test/telemetry-*.test.ts`, `test/decisions-store.test.ts`, `test/cli-telemetry.test.ts`, `test/cli-decision.test.ts`, `test/review-decisions.test.ts`, `test/telemetry-e2e.test.ts` | per-module, CLI, wiring, and e2e tests |

Existing code consumed (signatures — do not modify except where a task says so):
- `src/adapter/types.ts`: `Adapter { name: string; run(req: TurnRequest): Promise<TurnResult> }`, `TurnRequest`, `TurnResult { status, workdirDiff, transcriptRef, summary, sessionId, authorship, usage: { tokens: TokenUsage; billingType } }`, `TokenUsage { inputTokens, cacheReadInputTokens, outputTokens, reasoningOutputTokens }`, `Authorship { adapter, model: string | null, effort }`, `TurnStatus`, `BillingType`, `EMPTY_USAGE`.
- `test/helpers/workflow.ts`: `fakeTurn(overrides)`, `scriptedAdapter(behaviors, name?)`, `approveAll`, `rejectAll`, `capturingPresenter(approve)`, `tempWorkdir()`, `tempGitRepo()`, `writesArtifact(relPath, content, overrides?)`, `seedApprovedBuild(dir, opts?)`.
- Adapter names are `"codex"` and `"claude-code"` (the `DEFAULT_MODEL` keys must match these exactly).
- Both adapters normalize `reasoningOutputTokens` as a **subset of** `outputTokens` (claude always reports 0), so cost math uses `outputTokens` alone — reasoning bills at the output rate, matching both vendors.

---

### Task 1: Diff stats parser

**Files:**
- Create: `src/telemetry/diffstat.ts`
- Test: `test/telemetry-diffstat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks rely on these exact names):
  - `interface FileTouch { path: string; insertions: number; deletions: number }`
  - `function parseDiffStats(diff: string): FileTouch[]` — sorted by path; empty diff → `[]`; binary files omitted; a file appearing twice in one diff merges its counts.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-diffstat.test.ts
import { describe, expect, it } from "vitest";
import { parseDiffStats } from "../src/telemetry/diffstat.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line",
  "-old",
  "+new",
  "+added",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "",
].join("\n");

describe("parseDiffStats", () => {
  it("counts insertions and deletions per file, sorted by path", () => {
    expect(parseDiffStats(DIFF)).toEqual([
      { path: "src/a.ts", insertions: 2, deletions: 1 },
      { path: "src/gone.ts", insertions: 0, deletions: 1 },
      { path: "src/new.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("returns [] for an empty diff", () => {
    expect(parseDiffStats("")).toEqual([]);
  });

  it("omits binary files (no text hunks to count)", () => {
    const binary = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(parseDiffStats(binary)).toEqual([]);
  });

  it("counts hunk content lines that merely look like headers as content", () => {
    const tricky = [
      "diff --git a/x.ts b/x.ts",
      "index 1111111..2222222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "--- a/sneaky.ts", // a deleted content line, not a file header
      "+++ b/sneaky.ts", // an added content line, not a file header
      "",
    ].join("\n");
    expect(parseDiffStats(tricky)).toEqual([{ path: "x.ts", insertions: 1, deletions: 1 }]);
  });

  it("is total garbage-tolerant: nonsense input yields []", () => {
    expect(parseDiffStats("not a diff\nat all\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-diffstat.test.ts`
Expected: FAIL — `Cannot find module '../src/telemetry/diffstat.js'` (or equivalent).

- [ ] **Step 3: Write the implementation**

```ts
// src/telemetry/diffstat.ts

export interface FileTouch {
  path: string;
  insertions: number;
  deletions: number;
}

/**
 * Numstat-style per-file line counts from a unified diff. File headers
 * (`---`/`+++`) are only honored outside hunks — inside a hunk a line starting
 * with `-`/`+` is content, even if it reads like a header (same hardening as
 * evals' diffPaths). Binary files have no hunks and are omitted.
 */
export function parseDiffStats(diff: string): FileTouch[] {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  let current: { insertions: number; deletions: number } | null = null;
  let oldPath: string | null = null;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      oldPath = line.slice(4);
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const newPath = line.slice(4);
      let path: string | null = null;
      if (newPath !== "/dev/null" && newPath.startsWith("b/")) path = newPath.slice(2);
      else if (newPath === "/dev/null" && oldPath !== null && oldPath.startsWith("a/")) path = oldPath.slice(2);
      if (path !== null) {
        const existing = stats.get(path) ?? { insertions: 0, deletions: 0 };
        stats.set(path, existing);
        current = existing;
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || current === null) continue;
    if (line.startsWith("+")) current.insertions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }

  return [...stats.entries()]
    .map(([path, s]) => ({ path, insertions: s.insertions, deletions: s.deletions }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telemetry-diffstat.test.ts`
Expected: PASS (5 tests). Also run `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/diffstat.ts test/telemetry-diffstat.test.ts
git commit -m "Add telemetry diff stats parser"
```

---

### Task 2: Turn ledger — record type, append, forgiving read

**Files:**
- Create: `src/telemetry/ledger.ts`
- Test: `test/telemetry-ledger.test.ts`

**Interfaces:**
- Consumes: `TurnStatus`, `BillingType`, `Authorship`, `TokenUsage` from `src/adapter/types.ts`; `FileTouch` from `src/telemetry/diffstat.ts` (Task 1).
- Produces:
  - `const TELEMETRY_DIR = ".tackle/telemetry"`, `const TURNS_FILE = ".tackle/telemetry/turns.jsonl"`
  - `interface TurnRecordV1 { schema: "turn-record/v1"; at: string; context: string; durationMs: number; status: TurnStatus; billingType: BillingType; authorship: Authorship; tokens: TokenUsage; filesTouched: FileTouch[]; sessionId: string | null; transcriptRef: string }`
  - `async function appendTurnRecord(repoDir: string, record: TurnRecordV1): Promise<void>`
  - `interface LedgerRead { records: TurnRecordV1[]; malformed: number }`
  - `async function readTurnRecords(repoDir: string): Promise<LedgerRead>` — missing file → `{ records: [], malformed: 0 }`; a line that isn't JSON, isn't an object, or whose `schema !== "turn-record/v1"` is skipped and counted.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-ledger.test.ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTurnRecord, readTurnRecords, TURNS_FILE, type TurnRecordV1 } from "../src/telemetry/ledger.js";
import { tempWorkdir } from "./helpers/workflow.js";

function record(overrides: Partial<TurnRecordV1> = {}): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: "2026-07-07T10:00:00.000Z",
    context: "turn",
    durationMs: 1200,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: null, effort: "medium" },
    tokens: { inputTokens: 10, cacheReadInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 1 },
    filesTouched: [{ path: "src/a.ts", insertions: 2, deletions: 1 }],
    sessionId: "s-1",
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

describe("turn ledger", () => {
  it("appends one self-contained JSON line per record and reads them back", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, record());
    await appendTurnRecord(dir, record({ context: "phase:build" }));
    const raw = await readFile(join(dir, TURNS_FILE), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    const { records, malformed } = await readTurnRecords(dir);
    expect(malformed).toBe(0);
    expect(records.map((r) => r.context)).toEqual(["turn", "phase:build"]);
    expect(records[0]).toEqual(record());
  });

  it("missing ledger reads as empty, not an error", async () => {
    const dir = await tempWorkdir();
    expect(await readTurnRecords(dir)).toEqual({ records: [], malformed: 0 });
  });

  it("skips and counts malformed lines (forgiving reader)", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, record());
    await appendFile(join(dir, TURNS_FILE), "not json\n");
    await appendFile(join(dir, TURNS_FILE), JSON.stringify({ schema: "other/v9" }) + "\n");
    await appendFile(join(dir, TURNS_FILE), '"a bare string"\n');
    const { records, malformed } = await readTurnRecords(dir);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(3);
  });

  it("blank lines are ignored, not counted malformed", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle/telemetry"), { recursive: true });
    await appendFile(join(dir, TURNS_FILE), "\n\n");
    expect(await readTurnRecords(dir)).toEqual({ records: [], malformed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telemetry/ledger.ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Authorship, BillingType, TokenUsage, TurnStatus } from "../adapter/types.js";
import type { FileTouch } from "./diffstat.js";

export const TELEMETRY_DIR = ".tackle/telemetry";
export const TURNS_FILE = ".tackle/telemetry/turns.jsonl";

/** One real turn. Self-contained; no prompt or diff body — transcriptRef is the evidence pointer. */
export interface TurnRecordV1 {
  schema: "turn-record/v1";
  at: string; // ISO-8601, turn start
  context: string; // "turn" | "phase:<name>" | "review:reviewer" | "review:fix"
  durationMs: number;
  status: TurnStatus;
  billingType: BillingType;
  authorship: Authorship;
  tokens: TokenUsage;
  filesTouched: FileTouch[];
  sessionId: string | null;
  transcriptRef: string;
}

export async function appendTurnRecord(repoDir: string, record: TurnRecordV1): Promise<void> {
  await mkdir(join(repoDir, TELEMETRY_DIR), { recursive: true });
  await appendFile(join(repoDir, TURNS_FILE), JSON.stringify(record) + "\n");
}

export interface LedgerRead {
  records: TurnRecordV1[];
  malformed: number;
}

/** Forgiving reader: malformed lines are skipped and counted, never fatal. */
export async function readTurnRecords(repoDir: string): Promise<LedgerRead> {
  let raw: string;
  try {
    raw = await readFile(join(repoDir, TURNS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], malformed: 0 };
    throw err;
  }
  const records: TurnRecordV1[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== "turn-record/v1") {
      malformed += 1;
      continue;
    }
    records.push(parsed as TurnRecordV1);
  }
  return { records, malformed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telemetry-ledger.test.ts`
Expected: PASS (4 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/ledger.ts test/telemetry-ledger.test.ts
git commit -m "Add append-only turn ledger with forgiving reader"
```

---

### Task 3: `recordedRun` capture seam

**Files:**
- Create: `src/telemetry/record.ts`
- Test: `test/telemetry-record.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `TurnRequest`, `TurnResult` from `src/adapter/types.ts`; `parseDiffStats`, `FileTouch` (Task 1); `appendTurnRecord`, `TurnRecordV1` (Task 2).
- Produces:
  - `interface RecordedRunOptions { repoDir: string; context: string; warn?: (message: string) => void }`
  - `async function recordedRun(adapter: Adapter, req: TurnRequest, opts: RecordedRunOptions): Promise<TurnResult>` — returns the adapter's result **unchanged** (same object identity); appends one ledger line; append/parse failures warn (default: stderr) and never throw; an adapter `run()` throw propagates with nothing recorded.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-record.test.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapter/types.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { recordedRun } from "../src/telemetry/record.js";
import { fakeTurn, scriptedAdapter, tempWorkdir } from "./helpers/workflow.js";

const REQ = { prompt: "p", workdir: "/w", effort: "medium" as const };

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " keep",
  "+new",
  "",
].join("\n");

describe("recordedRun", () => {
  it("returns the result unchanged and appends one record with the context", async () => {
    const dir = await tempWorkdir();
    const result = fakeTurn({ workdirDiff: DIFF, status: "completed" });
    const adapter = scriptedAdapter([async () => result]);
    const returned = await recordedRun(adapter, REQ, { repoDir: dir, context: "phase:build" });
    expect(returned).toBe(result); // identity, not a copy
    const { records } = await readTurnRecords(dir);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r?.schema).toBe("turn-record/v1");
    expect(r?.context).toBe("phase:build");
    expect(r?.status).toBe("completed");
    expect(r?.billingType).toBe("subscription");
    expect(r?.filesTouched).toEqual([{ path: "src/a.ts", insertions: 1, deletions: 0 }]);
    expect(r?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(r?.at ?? ""))).toBe(false);
    expect(r?.transcriptRef).toBe(result.transcriptRef);
    expect(r?.sessionId).toBe(result.sessionId);
  });

  it("a failed ledger append warns and still returns the result", async () => {
    const dir = await tempWorkdir();
    // make .tackle a FILE so mkdir(.tackle/telemetry) fails
    await writeFile(join(dir, ".tackle"), "not a dir");
    const warnings: string[] = [];
    const result = fakeTurn();
    const adapter = scriptedAdapter([async () => result]);
    const returned = await recordedRun(adapter, REQ, {
      repoDir: dir,
      context: "turn",
      warn: (m) => warnings.push(m),
    });
    expect(returned).toBe(result);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("telemetry");
  });

  it("an adapter throw propagates and records nothing", async () => {
    const dir = await tempWorkdir();
    const adapter: Adapter = {
      name: "boom",
      run: async () => {
        throw new Error("spawn failed");
      },
    };
    await expect(recordedRun(adapter, REQ, { repoDir: dir, context: "turn" })).rejects.toThrow("spawn failed");
    expect((await readTurnRecords(dir)).records).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telemetry/record.ts
import type { Adapter, TurnRequest, TurnResult } from "../adapter/types.js";
import type { FileTouch } from "./diffstat.js";
import { parseDiffStats } from "./diffstat.js";
import type { TurnRecordV1 } from "./ledger.js";
import { appendTurnRecord } from "./ledger.js";

export interface RecordedRunOptions {
  /** Repo whose .tackle/telemetry ledger receives the record (the turn's target repo). */
  repoDir: string;
  /** "turn" | "phase:<name>" | "review:reviewer" | "review:fix" */
  context: string;
  /** Telemetry failures warn here and never fail the turn. Default: stderr. */
  warn?: (message: string) => void;
}

/**
 * The capture seam: times the call, runs the adapter, appends one ledger line,
 * returns the result unchanged. Call sites swap adapter.run(...) for this.
 */
export async function recordedRun(adapter: Adapter, req: TurnRequest, opts: RecordedRunOptions): Promise<TurnResult> {
  const startedAt = Date.now();
  const result = await adapter.run(req);
  const durationMs = Date.now() - startedAt;
  const warn = opts.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  let filesTouched: FileTouch[] = [];
  try {
    filesTouched = parseDiffStats(result.workdirDiff);
  } catch (err) {
    warn(`telemetry: could not derive file stats from the turn diff: ${err instanceof Error ? err.message : String(err)}`);
  }

  const record: TurnRecordV1 = {
    schema: "turn-record/v1",
    at: new Date(startedAt).toISOString(),
    context: opts.context,
    durationMs,
    status: result.status,
    billingType: result.usage.billingType,
    authorship: result.authorship,
    tokens: result.usage.tokens,
    filesTouched,
    sessionId: result.sessionId,
    transcriptRef: result.transcriptRef,
  };
  try {
    await appendTurnRecord(opts.repoDir, record);
  } catch (err) {
    warn(`telemetry: failed to append the turn record: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telemetry-record.test.ts`
Expected: PASS (3 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/record.ts test/telemetry-record.test.ts
git commit -m "Add recordedRun telemetry capture seam"
```

---

### Task 4: Pricing table

**Files:**
- Create: `src/telemetry/pricing.ts`
- Test: `test/telemetry-pricing.test.ts`

**Interfaces:**
- Consumes: `TokenUsage` from `src/adapter/types.ts`.
- Produces:
  - `const PRICING_AS_OF: string` (a `YYYY-MM-DD` date literal)
  - `interface ModelPricing { pattern: string; inputPerMtok: number; cacheReadPerMtok: number; outputPerMtok: number }`
  - `const PRICING: ModelPricing[]` (ordered; first case-insensitive substring match wins)
  - `const DEFAULT_MODEL: Record<string, string>` — keys are adapter names `"codex"` and `"claude-code"`
  - `function resolveModelLabel(authorship: { adapter: string; model: string | null }): string`
  - `function findPricing(model: string): ModelPricing | null`
  - `function costUsd(tokens: TokenUsage, pricing: ModelPricing): number`

> The table is **data**, updated by editing this file; `PRICING_AS_OF` prints in the report footer so staleness is visible. Patterns are deliberately narrow — a genuinely new model must land in `unpriced` loudly, not silently match a stale row.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-pricing.test.ts
import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_MODEL, findPricing, PRICING_AS_OF, resolveModelLabel } from "../src/telemetry/pricing.js";

describe("pricing", () => {
  it("matches model names by ordered substring, case-insensitive", () => {
    expect(findPricing("gpt-5.1-codex-max")?.pattern).toBe("gpt-5.1");
    expect(findPricing("GPT-5.1-Codex-Mini")?.pattern).toBe("gpt-5.1-codex-mini");
    expect(findPricing("claude-sonnet-4-5-20250929")?.pattern).toBe("claude-sonnet-4");
  });

  it("unknown models get null, never a silent zero-price row", () => {
    expect(findPricing("wild-new-model-9000")).toBeNull();
  });

  it("resolves a null model to the adapter default, and unknown adapters to a label that prices as unpriced", () => {
    expect(resolveModelLabel({ adapter: "codex", model: null })).toBe(DEFAULT_MODEL["codex"]);
    expect(resolveModelLabel({ adapter: "claude-code", model: null })).toBe(DEFAULT_MODEL["claude-code"]);
    expect(resolveModelLabel({ adapter: "codex", model: "gpt-5.1" })).toBe("gpt-5.1");
    const fallback = resolveModelLabel({ adapter: "someday", model: null });
    expect(fallback).toContain("someday");
    expect(findPricing(fallback)).toBeNull();
  });

  it("adapter defaults resolve to priced rows", () => {
    for (const model of Object.values(DEFAULT_MODEL)) expect(findPricing(model)).not.toBeNull();
  });

  it("costUsd: input + cache-read + output only (reasoning is a subset of output)", () => {
    const p = { pattern: "x", inputPerMtok: 1.25, cacheReadPerMtok: 0.125, outputPerMtok: 10 };
    const tokens = { inputTokens: 1_000_000, cacheReadInputTokens: 2_000_000, outputTokens: 100_000, reasoningOutputTokens: 90_000 };
    expect(costUsd(tokens, p)).toBeCloseTo(1.25 + 0.25 + 1.0, 10);
  });

  it("carries an asOf date for the report footer", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-pricing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telemetry/pricing.ts
import type { TokenUsage } from "../adapter/types.js";

/** Update rows/values when vendors change pricing; the report footer prints this date. */
export const PRICING_AS_OF = "2026-07-07";

export interface ModelPricing {
  /** Case-insensitive substring of the model name; first match in PRICING order wins. */
  pattern: string;
  inputPerMtok: number;
  cacheReadPerMtok: number;
  outputPerMtok: number;
}

// $ per Mtok. reasoningOutputTokens is a subset of outputTokens in both
// adapters' normalization (claude reports 0), so costUsd uses outputTokens
// alone — reasoning bills at the output rate, matching both vendors.
// Narrow patterns on purpose: a new model must show up as `unpriced`, loudly.
export const PRICING: ModelPricing[] = [
  { pattern: "gpt-5.1-codex-mini", inputPerMtok: 0.25, cacheReadPerMtok: 0.025, outputPerMtok: 2 },
  { pattern: "gpt-5.1", inputPerMtok: 1.25, cacheReadPerMtok: 0.125, outputPerMtok: 10 },
  { pattern: "gpt-5", inputPerMtok: 1.25, cacheReadPerMtok: 0.125, outputPerMtok: 10 },
  { pattern: "claude-opus-4-5", inputPerMtok: 5, cacheReadPerMtok: 0.5, outputPerMtok: 25 },
  { pattern: "claude-opus-4-1", inputPerMtok: 15, cacheReadPerMtok: 1.5, outputPerMtok: 75 },
  { pattern: "claude-sonnet-4", inputPerMtok: 3, cacheReadPerMtok: 0.3, outputPerMtok: 15 },
  { pattern: "claude-haiku-4", inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 5 },
];

/** authorship.model: null means "backend default"; keys are Adapter.name values. */
export const DEFAULT_MODEL: Record<string, string> = {
  codex: "gpt-5.1-codex",
  "claude-code": "claude-sonnet-4-5",
};

export function resolveModelLabel(authorship: { adapter: string; model: string | null }): string {
  if (authorship.model !== null) return authorship.model;
  return DEFAULT_MODEL[authorship.adapter] ?? `${authorship.adapter} default (unknown model)`;
}

export function findPricing(model: string): ModelPricing | null {
  const needle = model.toLowerCase();
  return PRICING.find((p) => needle.includes(p.pattern)) ?? null;
}

export function costUsd(tokens: TokenUsage, pricing: ModelPricing): number {
  return (
    (tokens.inputTokens * pricing.inputPerMtok +
      tokens.cacheReadInputTokens * pricing.cacheReadPerMtok +
      tokens.outputTokens * pricing.outputPerMtok) /
    1_000_000
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telemetry-pricing.test.ts`
Expected: PASS (6 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/pricing.ts test/telemetry-pricing.test.ts
git commit -m "Add checked-in pricing table with loud unpriced fallback"
```

---

### Task 5: Report — compute on read + text rendering

**Files:**
- Create: `src/telemetry/report.ts`
- Test: `test/telemetry-report.test.ts`

**Interfaces:**
- Consumes: `TokenUsage` from `src/adapter/types.ts`; `TurnRecordV1` (Task 2); `costUsd`, `findPricing`, `PRICING_AS_OF`, `resolveModelLabel` (Task 4).
- Produces:
  - `const CHURN_TOP = 20`
  - `interface ChurnRow { path: string; touches: number; insertions: number; deletions: number }`
  - `interface CostRow { model: string; tokens: TokenUsage; usd: number }`
  - `interface TelemetryReport { schema: "telemetry-report/v1"; turns: number; byContext: Record<string, { turns: number; byStatus: Record<string, number> }>; tokens: { total: TokenUsage; byModel: Record<string, TokenUsage> }; billing: Record<string, { turns: number; tokens: TokenUsage }>; cost: { asOf: string; priced: CostRow[]; totalUsd: number; actualMeteredUsd: number; unpriced: Array<{ model: string; tokens: TokenUsage }> }; churn: { files: ChurnRow[]; multiTouch: number; totalFiles: number } }`
  - `function computeTelemetryReport(records: TurnRecordV1[]): TelemetryReport` (pure)
  - `function renderTelemetryReport(report: TelemetryReport, opts?: { malformed: number }): string`

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-report.test.ts
import { describe, expect, it } from "vitest";
import type { TurnRecordV1 } from "../src/telemetry/ledger.js";
import { computeTelemetryReport, renderTelemetryReport } from "../src/telemetry/report.js";

function rec(overrides: Partial<TurnRecordV1>): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: "2026-07-07T10:00:00.000Z",
    context: "turn",
    durationMs: 1000,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" },
    tokens: { inputTokens: 1_000_000, cacheReadInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0 },
    filesTouched: [],
    sessionId: null,
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

const RECORDS: TurnRecordV1[] = [
  rec({ context: "phase:build", filesTouched: [{ path: "src/a.ts", insertions: 10, deletions: 2 }] }),
  rec({
    context: "phase:build",
    status: "timeout",
    filesTouched: [
      { path: "src/a.ts", insertions: 5, deletions: 5 },
      { path: "src/b.ts", insertions: 1, deletions: 0 },
    ],
  }),
  rec({ context: "review:reviewer", authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
  rec({ context: "turn", billingType: "metered" }),
  rec({ context: "turn", authorship: { adapter: "codex", model: "wild-new-model", effort: "low" } }),
];

describe("computeTelemetryReport", () => {
  const report = computeTelemetryReport(RECORDS);

  it("counts turns by context and status", () => {
    expect(report.turns).toBe(5);
    expect(report.byContext["phase:build"]).toEqual({ turns: 2, byStatus: { completed: 1, timeout: 1 } });
    expect(report.byContext["turn"]?.turns).toBe(2);
  });

  it("totals tokens and splits by resolved model (null -> adapter default)", () => {
    expect(report.tokens.total.inputTokens).toBe(5_000_000);
    expect(Object.keys(report.tokens.byModel).sort()).toEqual(["claude-sonnet-4-5", "gpt-5.1-codex", "wild-new-model"]);
    expect(report.tokens.byModel["gpt-5.1-codex"]?.inputTokens).toBe(3_000_000);
  });

  it("splits billing and computes the actual-metered cost", () => {
    expect(report.billing["subscription"]?.turns).toBe(4);
    expect(report.billing["metered"]?.turns).toBe(1);
    // one metered gpt-5.1 turn: 1.25 (input) + 1.0 (output)
    expect(report.cost.actualMeteredUsd).toBeCloseTo(2.25, 10);
  });

  it("prices known models and reports unknown models as unpriced, never $0", () => {
    // gpt-5.1-codex: 3 turns = 3.75 + 3.0; claude-sonnet-4-5: 1 turn = 3.0 + 1.5
    expect(report.cost.totalUsd).toBeCloseTo(6.75 + 4.5, 10);
    expect(report.cost.unpriced).toEqual([
      { model: "wild-new-model", tokens: RECORDS[4]?.tokens },
    ]);
  });

  it("aggregates churn per file with touch counts", () => {
    expect(report.churn.files).toEqual([
      { path: "src/a.ts", touches: 2, insertions: 15, deletions: 7 },
      { path: "src/b.ts", touches: 1, insertions: 1, deletions: 0 },
    ]);
    expect(report.churn.multiTouch).toBe(1);
    expect(report.churn.totalFiles).toBe(2);
  });

  it("handles zero records", () => {
    const empty = computeTelemetryReport([]);
    expect(empty.turns).toBe(0);
    expect(empty.cost.totalUsd).toBe(0);
    expect(empty.churn.files).toEqual([]);
  });
});

describe("renderTelemetryReport", () => {
  const report = computeTelemetryReport(RECORDS);

  it("renders all sections, the metered alert, the unpriced line, and the asOf footer", () => {
    const text = renderTelemetryReport(report, { malformed: 2 });
    expect(text).toContain("turns: 5");
    expect(text).toContain("phase:build");
    expect(text).toContain("timeout 1");
    expect(text).toContain("metered");
    expect(text).toContain("UNPRICED wild-new-model");
    expect(text).toContain(report.cost.asOf);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("skipped 2 malformed ledger line(s)");
    expect(text).toContain("actually billed metered");
  });

  it("omits the malformed warning when there is none", () => {
    expect(renderTelemetryReport(report)).not.toContain("malformed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telemetry/report.ts
import type { TokenUsage } from "../adapter/types.js";
import type { TurnRecordV1 } from "./ledger.js";
import { costUsd, findPricing, PRICING_AS_OF, resolveModelLabel } from "./pricing.js";

export const CHURN_TOP = 20;

export interface ChurnRow {
  path: string;
  touches: number;
  insertions: number;
  deletions: number;
}

export interface CostRow {
  model: string;
  tokens: TokenUsage;
  usd: number;
}

export interface TelemetryReport {
  schema: "telemetry-report/v1";
  turns: number;
  byContext: Record<string, { turns: number; byStatus: Record<string, number> }>;
  tokens: { total: TokenUsage; byModel: Record<string, TokenUsage> };
  billing: Record<string, { turns: number; tokens: TokenUsage }>;
  cost: {
    asOf: string;
    priced: CostRow[];
    /** metered-equivalent: what the window's tokens would cost on the API */
    totalUsd: number;
    /** the subset of totalUsd from turns that actually billed metered */
    actualMeteredUsd: number;
    /** tokens excluded from totalUsd because no pricing row matched — fail loud */
    unpriced: Array<{ model: string; tokens: TokenUsage }>;
  };
  churn: { files: ChurnRow[]; multiTouch: number; totalFiles: number };
}

function zeroTokens(): TokenUsage {
  return { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

function addTokens(into: TokenUsage, t: TokenUsage): void {
  into.inputTokens += t.inputTokens;
  into.cacheReadInputTokens += t.cacheReadInputTokens;
  into.outputTokens += t.outputTokens;
  into.reasoningOutputTokens += t.reasoningOutputTokens;
}

/** Every figure computed fresh from the records; nothing persisted. */
export function computeTelemetryReport(records: TurnRecordV1[]): TelemetryReport {
  const byContext: Record<string, { turns: number; byStatus: Record<string, number> }> = {};
  const total = zeroTokens();
  const byModel: Record<string, TokenUsage> = {};
  const billing: Record<string, { turns: number; tokens: TokenUsage }> = {};
  const churnMap = new Map<string, ChurnRow>();
  let actualMeteredUsd = 0;

  for (const r of records) {
    const ctx = (byContext[r.context] ??= { turns: 0, byStatus: {} });
    ctx.turns += 1;
    ctx.byStatus[r.status] = (ctx.byStatus[r.status] ?? 0) + 1;

    addTokens(total, r.tokens);
    const model = resolveModelLabel(r.authorship);
    addTokens((byModel[model] ??= zeroTokens()), r.tokens);

    const bill = (billing[r.billingType] ??= { turns: 0, tokens: zeroTokens() });
    bill.turns += 1;
    addTokens(bill.tokens, r.tokens);

    if (r.billingType === "metered") {
      const pricing = findPricing(model);
      if (pricing !== null) actualMeteredUsd += costUsd(r.tokens, pricing);
    }

    for (const f of r.filesTouched) {
      const row = churnMap.get(f.path) ?? { path: f.path, touches: 0, insertions: 0, deletions: 0 };
      row.touches += 1;
      row.insertions += f.insertions;
      row.deletions += f.deletions;
      churnMap.set(f.path, row);
    }
  }

  const priced: CostRow[] = [];
  const unpriced: Array<{ model: string; tokens: TokenUsage }> = [];
  let totalUsd = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    const pricing = findPricing(model);
    if (pricing === null) {
      unpriced.push({ model, tokens });
      continue;
    }
    const usd = costUsd(tokens, pricing);
    priced.push({ model, tokens, usd });
    totalUsd += usd;
  }
  priced.sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));

  const allFiles = [...churnMap.values()].sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path));

  return {
    schema: "telemetry-report/v1",
    turns: records.length,
    byContext,
    tokens: { total, byModel },
    billing,
    cost: { asOf: PRICING_AS_OF, priced, totalUsd, actualMeteredUsd, unpriced },
    churn: {
      files: allFiles.slice(0, CHURN_TOP),
      multiTouch: allFiles.filter((f) => f.touches > 1).length,
      totalFiles: allFiles.length,
    },
  };
}

function fmtTokens(t: TokenUsage): string {
  return `in ${t.inputTokens}, cache ${t.cacheReadInputTokens}, out ${t.outputTokens} (reasoning ${t.reasoningOutputTokens})`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function renderTelemetryReport(report: TelemetryReport, opts: { malformed: number } = { malformed: 0 }): string {
  const lines: string[] = [];

  lines.push(`turns: ${report.turns}`);
  for (const [context, s] of Object.entries(report.byContext).sort(([a], [b]) => a.localeCompare(b))) {
    const statuses = Object.entries(s.byStatus)
      .map(([status, n]) => `${status} ${n}`)
      .join(", ");
    lines.push(`  ${context.padEnd(18)} ${s.turns} (${statuses})`);
  }

  lines.push("", `tokens: ${fmtTokens(report.tokens.total)}`);
  for (const [model, t] of Object.entries(report.tokens.byModel).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${model.padEnd(28)} ${fmtTokens(t)}`);
  }

  lines.push("", "billing:");
  for (const [type, row] of Object.entries(report.billing).sort(([a], [b]) => a.localeCompare(b))) {
    const alert = type === "metered" ? "   <-- metered turns present (subscription gate!)" : "";
    lines.push(`  ${type.padEnd(14)} ${row.turns} turn(s), ${fmtTokens(row.tokens)}${alert}`);
  }

  lines.push("", `metered-equivalent cost (pricing as of ${report.cost.asOf}):`);
  for (const row of report.cost.priced) lines.push(`  ${row.model.padEnd(28)} ${fmtUsd(row.usd)}`);
  const actual =
    report.cost.actualMeteredUsd > 0 ? ` (of which ${fmtUsd(report.cost.actualMeteredUsd)} actually billed metered)` : "";
  lines.push(`  ${"total".padEnd(28)} ${fmtUsd(report.cost.totalUsd)}${actual}`);
  for (const u of report.cost.unpriced) {
    lines.push(`  UNPRICED ${u.model}: ${fmtTokens(u.tokens)} — not in the total; add a row to src/telemetry/pricing.ts`);
  }

  const capNote = report.churn.totalFiles > CHURN_TOP ? ` (top ${CHURN_TOP} shown)` : "";
  lines.push("", `churn: ${report.churn.totalFiles} file(s) touched, ${report.churn.multiTouch} touched more than once${capNote}`);
  for (const f of report.churn.files) lines.push(`  ${f.path}  x${f.touches}  +${f.insertions} -${f.deletions}`);

  if (opts.malformed > 0) lines.push("", `warning: skipped ${opts.malformed} malformed ledger line(s)`);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telemetry-report.test.ts`
Expected: PASS (8 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/report.ts test/telemetry-report.test.ts
git commit -m "Add compute-on-read telemetry report"
```

---

### Task 6: `tackle telemetry` CLI command

**Files:**
- Modify: `src/cli.ts` (add `registerTelemetryCommand`, call it in `buildProgram` next to `registerMapCommands`)
- Test: `test/cli-telemetry.test.ts`

**Interfaces:**
- Consumes: `readTurnRecords`, `appendTurnRecord`, `TurnRecordV1` (Task 2); `computeTelemetryReport`, `renderTelemetryReport` (Task 5); commander `InvalidArgumentError` (already imported in cli.ts).
- Produces: `tackle telemetry [--cwd <dir>] [--json] [--since <duration>]`. `--since` accepts `<n>d` / `<n>h`; anything else is an `InvalidArgumentError`. Malformed-line warning goes to **stderr**; the report still renders. Empty window with a clean ledger prints `no turns recorded`.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli-telemetry.test.ts
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import { appendTurnRecord, TURNS_FILE, type TurnRecordV1 } from "../src/telemetry/ledger.js";
import { tempWorkdir } from "./helpers/workflow.js";

function rec(overrides: Partial<TurnRecordV1> = {}): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: new Date().toISOString(),
    context: "turn",
    durationMs: 1000,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" },
    tokens: { inputTokens: 100, cacheReadInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
    filesTouched: [],
    sessionId: null,
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

async function run(args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return out.join("");
}

afterEach(() => vi.restoreAllMocks());

describe("tackle telemetry", () => {
  it("renders the text report over the ledger", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec());
    await appendTurnRecord(dir, rec({ context: "phase:build" }));
    const text = await run(["telemetry", "--cwd", dir]);
    expect(text).toContain("turns: 2");
    expect(text).toContain("phase:build");
  });

  it("--json emits the machine-readable report including the malformed count", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec());
    await appendFile(join(dir, TURNS_FILE), "garbage\n");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const parsed = JSON.parse(await run(["telemetry", "--cwd", dir, "--json"]));
    expect(parsed.schema).toBe("telemetry-report/v1");
    expect(parsed.turns).toBe(1);
    expect(parsed.malformed).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });

  it("--since filters to the trailing window", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec({ at: "2020-01-01T00:00:00.000Z" }));
    await appendTurnRecord(dir, rec());
    const text = await run(["telemetry", "--cwd", dir, "--since", "7d"]);
    expect(text).toContain("turns: 1");
  });

  it("rejects a malformed --since", async () => {
    const dir = await tempWorkdir();
    await expect(run(["telemetry", "--cwd", dir, "--since", "fortnight"])).rejects.toThrow();
  });

  it("empty ledger prints a friendly line and exits 0", async () => {
    const dir = await tempWorkdir();
    const text = await run(["telemetry", "--cwd", dir]);
    expect(text).toContain("no turns recorded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli-telemetry.test.ts`
Expected: FAIL — `unknown command 'telemetry'`.

- [ ] **Step 3: Implement the command**

In `src/cli.ts`, add imports:

```ts
import { readTurnRecords } from "./telemetry/ledger.js";
import { computeTelemetryReport, renderTelemetryReport } from "./telemetry/report.js";
```

Add next to `parseTimeout`:

```ts
function parseSince(v: string): number {
  const m = /^(\d+)([dh])$/.exec(v);
  const n = Number(m?.[1]);
  if (m === null || !Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError("since must look like 7d or 24h");
  }
  return n * (m[2] === "d" ? 86_400_000 : 3_600_000);
}
```

Add a registration function (near `registerMapCommands`):

```ts
function registerTelemetryCommand(program: Command, writeOut: (s: string) => void): void {
  program
    .command("telemetry")
    .description("Cost and friction report computed fresh from .tackle/telemetry/turns.jsonl")
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("--json", "print the report as JSON")
    .option("--since <duration>", "trailing window like 7d or 24h (default: all records)", parseSince)
    .action(async (options: { cwd: string; json?: boolean; since?: number }) => {
      const { records, malformed } = await readTurnRecords(options.cwd);
      if (malformed > 0) process.stderr.write(`warning: skipped ${malformed} malformed ledger line(s)\n`);
      const since = options.since;
      const windowed =
        since === undefined
          ? records
          : records.filter((r) => {
              const t = Date.parse(r.at);
              return Number.isFinite(t) && t >= Date.now() - since;
            });
      if (windowed.length === 0 && malformed === 0) {
        writeOut("no turns recorded\n");
        return;
      }
      const report = computeTelemetryReport(windowed);
      writeOut(
        options.json === true
          ? JSON.stringify({ ...report, malformed }, null, 2) + "\n"
          : renderTelemetryReport(report, { malformed }),
      );
    });
}
```

In `buildProgram`, after `registerMapCommands(program, writeOut);` add:

```ts
registerTelemetryCommand(program, writeOut);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli-telemetry.test.ts`
Expected: PASS (5 tests). Also `npx vitest run` (full suite) — no regressions; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-telemetry.test.ts
git commit -m "Add tackle telemetry command"
```

---

### Task 7: Wire `recordedRun` at the four real-turn call sites

**Files:**
- Modify: `src/cli.ts` (turn command action, ~line 241)
- Modify: `src/workflow/phase.ts` (the `opts.adapter.run(...)` call in the turn loop, ~line 252)
- Modify: `src/workflow/review.ts` (`runFixTurn` `ctx.author.run(...)` ~line 371; `runReviewerTurn` `ctx.reviewer.run(...)` ~line 410)
- Modify: `test/cli-turn.test.ts` (pass `--cwd <tempdir>` so tests stop writing telemetry into the real repo)
- Test: `test/telemetry-capture.test.ts`

**Interfaces:**
- Consumes: `recordedRun` (Task 3); `readTurnRecords` (Task 2).
- Produces: ledger lines with contexts `turn`, `phase:specs|plan|build|pr`, `review:reviewer`, `review:fix`. The eval runner stays untouched. No call-site behavior change (result flows through unchanged).

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-capture.test.ts
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { runPhase } from "../src/workflow/phase.js";
import { runReviewPhase } from "../src/workflow/review.js";
import {
  approveAll,
  fakeTurn,
  scriptedAdapter,
  seedApprovedBuild,
  tempGitRepo,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const FINDINGS =
  'issues\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "bad" }] }\n```\n';

describe("telemetry capture at the real-turn call sites", () => {
  it("tackle turn records context 'turn' in the --cwd repo", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([async () => fakeTurn()]);
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(["turn", "hello", "--cwd", dir], { from: "user" });
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["turn"]);
  });

  it("runPhase records context 'phase:<name>'", async () => {
    const dir = await tempGitRepo();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    const outcome = await runPhase({
      phase: "specs",
      workdir: dir,
      adapter,
      presenter: approveAll,
      canEnter: true,
      request: "do it",
    });
    expect(outcome).toBe("approved");
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["phase:specs"]);
  });

  it("review records 'review:reviewer' and 'review:fix' contexts", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // round 1: blocking finding; fix turn returns the same tree; round 2: clean
    const reviewer = scriptedAdapter(
      [
        async () => fakeTurn({ summary: FINDINGS, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
        async () => fakeTurn({ summary: CLEAN, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
      ],
      "claude-code",
    );
    const author = scriptedAdapter([async () => fakeTurn({ summary: "fixed", workdirDiff: diff })]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: approveAll });
    expect(outcome).toBe("approved");
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["review:reviewer", "review:fix", "review:reviewer"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telemetry-capture.test.ts`
Expected: FAIL — ledgers are empty (`expected [] to equal ['turn']`).

- [ ] **Step 3: Wire the call sites**

`src/cli.ts` — add import `import { recordedRun } from "./telemetry/record.js";` and change the turn action:

```ts
    const adapter = opts.adapter ?? new CodexAdapter();
    const result = await recordedRun(
      adapter,
      {
        prompt,
        workdir: options.cwd,
        effort: options.effort,
        model: options.model,
        timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
      },
      { repoDir: options.cwd, context: "turn" },
    );
```

`src/workflow/phase.ts` — add import `import { recordedRun } from "../telemetry/record.js";` and change the turn-loop call:

```ts
    const result = await recordedRun(
      opts.adapter,
      {
        prompt,
        workdir,
        effort: opts.effort ?? "medium",
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      },
      { repoDir: workdir, context: `phase:${opts.phase}` },
    );
```

`src/workflow/review.ts` — add import `import { recordedRun } from "../telemetry/record.js";`; in `runFixTurn`:

```ts
    const result = await recordedRun(
      ctx.author,
      {
        prompt,
        workdir,
        effort: ctx.effort ?? "medium",
        ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
      },
      { repoDir: workdir, context: "review:fix" },
    );
```

and in `runReviewerTurn`:

```ts
    const result = await recordedRun(
      ctx.reviewer,
      {
        prompt,
        workdir,
        effort: ctx.effort ?? "medium",
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
      },
      { repoDir: workdir, context: "review:reviewer" },
    );
```

`test/cli-turn.test.ts` — only the first test ("runs the adapter with parsed options...") actually executes a turn, and it uses the default cwd (the real repo), which would now append telemetry there. Add `import { tempWorkdir } from "./helpers/workflow.js";`, then in that test: create `const dir = await tempWorkdir();`, append `"--cwd", dir` to the parsed args, and change the expectation's `workdir: process.cwd()` to `workdir: dir`. (The other three tests reject at argument parsing before any turn runs — leave them alone.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/telemetry-capture.test.ts test/cli-turn.test.ts`
Expected: PASS. Then the full suite: `npx vitest run` — no regressions (phase/review/spine tests now also write ledgers into their temp repos, which is harmless). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/workflow/phase.ts src/workflow/review.ts test/telemetry-capture.test.ts test/cli-turn.test.ts
git commit -m "Record telemetry at the four real-turn call sites"
```

---

### Task 8: Decisions store — parse, read, append

**Files:**
- Create: `src/decisions/store.ts`
- Test: `test/decisions-store.test.ts`

**Interfaces:**
- Consumes: nothing outside node builtins.
- Produces:
  - `const DECISIONS_FILE = ".tackle/decisions.md"`
  - `type DecisionSource = "human" | "workflow"`
  - `interface DecisionEntry { id: number; date: string; title: string; decision: string; rejected: string[]; source: DecisionSource }`
  - `interface NewDecision { title: string; decision: string; rejected: string[]; source: DecisionSource }`
  - `function formatDecisionId(id: number): string` — `D-001` style (pads to 3, grows past 999)
  - `function parseDecisions(content: string): DecisionEntry[]` — throws a clear `Error` on any unparseable `## ` heading, missing `**Decision:**`/`**Source:**`, or invalid source
  - `async function readDecisions(repoDir: string): Promise<DecisionEntry[]>` — missing file → `[]`
  - `async function appendDecision(repoDir: string, entry: NewDecision, date?: string): Promise<string>` — returns the assigned ID string; ID = max existing + 1; parse failure blocks the append (throws before any write); atomic tmp + rename; creates the file (with a `# Decisions` preamble) and `.tackle/` if missing; newlines in field text collapse to spaces; blank title throws.

Entry format on disk (heading separator is ` — ` em dash, matching the spec):

```markdown
## D-003 — 2026-07-06 — Ship telemetry ledger as JSONL

- **Decision:** per-turn append-only ledger, digest computed on read
- **Rejected:** aggregate session-digest.json (read-modify-write, loses per-turn resolution)
- **Source:** human
```

- [ ] **Step 1: Write the failing test**

```ts
// test/decisions-store.test.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDecision,
  DECISIONS_FILE,
  formatDecisionId,
  parseDecisions,
  readDecisions,
} from "../src/decisions/store.js";
import { tempWorkdir } from "./helpers/workflow.js";

const SAMPLE = `# Decisions

## D-001 — 2026-07-06 — Ship telemetry ledger as JSONL

- **Decision:** per-turn append-only ledger, digest computed on read
- **Rejected:** aggregate session-digest.json (read-modify-write)
- **Source:** human

## D-002 — 2026-07-07 — Second thing

- **Decision:** did it
- **Source:** workflow
`;

describe("parseDecisions", () => {
  it("parses IDs, dates, titles, bullets, and sources", () => {
    const entries = parseDecisions(SAMPLE);
    expect(entries).toEqual([
      {
        id: 1,
        date: "2026-07-06",
        title: "Ship telemetry ledger as JSONL",
        decision: "per-turn append-only ledger, digest computed on read",
        rejected: ["aggregate session-digest.json (read-modify-write)"],
        source: "human",
      },
      { id: 2, date: "2026-07-07", title: "Second thing", decision: "did it", rejected: [], source: "workflow" },
    ]);
  });

  it("empty or preamble-only content parses to []", () => {
    expect(parseDecisions("")).toEqual([]);
    expect(parseDecisions("# Decisions\n\nsome prose\n")).toEqual([]);
  });

  it("throws on an unparseable heading", () => {
    expect(() => parseDecisions("## not a decision heading\n")).toThrow(/unparseable heading/);
  });

  it("throws on a missing Decision or Source line, and on an invalid source", () => {
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Source:** human\n")).toThrow(/missing/);
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Decision:** d\n")).toThrow(/missing/);
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Decision:** d\n- **Source:** robot\n")).toThrow(/source/);
  });
});

describe("appendDecision", () => {
  it("creates the file on first append and round-trips through the parser", async () => {
    const dir = await tempWorkdir();
    const id = await appendDecision(
      dir,
      { title: "First", decision: "do X", rejected: ["do Y", "do Z"], source: "human" },
      "2026-07-07",
    );
    expect(id).toBe("D-001");
    const entries = await readDecisions(dir);
    expect(entries).toEqual([
      { id: 1, date: "2026-07-07", title: "First", decision: "do X", rejected: ["do Y", "do Z"], source: "human" },
    ]);
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toContain("# Decisions");
  });

  it("assigns max ID + 1 and appends at the bottom", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), SAMPLE);
    const id = await appendDecision(dir, { title: "Third", decision: "d3", rejected: [], source: "workflow" }, "2026-07-07");
    expect(id).toBe("D-003");
    const entries = await readDecisions(dir);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries[2]?.title).toBe("Third");
  });

  it("refuses to append to an unparseable file, changing nothing", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), "## broken heading\n");
    await expect(appendDecision(dir, { title: "x", decision: "y", rejected: [], source: "human" })).rejects.toThrow(
      /unparseable heading/,
    );
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toBe("## broken heading\n");
  });

  it("collapses newlines in field text and rejects a blank title", async () => {
    const dir = await tempWorkdir();
    await appendDecision(dir, { title: "multi\nline", decision: "a\nb", rejected: [], source: "human" }, "2026-07-07");
    const entries = await readDecisions(dir);
    expect(entries[0]?.title).toBe("multi line");
    expect(entries[0]?.decision).toBe("a b");
    await expect(appendDecision(dir, { title: "  \n ", decision: "d", rejected: [], source: "human" })).rejects.toThrow(/title/);
  });

  it("missing file reads as []", async () => {
    expect(await readDecisions(await tempWorkdir())).toEqual([]);
  });
});

describe("formatDecisionId", () => {
  it("pads to three digits and grows past 999", () => {
    expect(formatDecisionId(7)).toBe("D-007");
    expect(formatDecisionId(1234)).toBe("D-1234");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decisions-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/decisions/store.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DECISIONS_FILE = ".tackle/decisions.md";

export type DecisionSource = "human" | "workflow";

export interface DecisionEntry {
  id: number;
  date: string; // YYYY-MM-DD
  title: string;
  decision: string;
  rejected: string[];
  source: DecisionSource;
}

export interface NewDecision {
  title: string;
  decision: string;
  rejected: string[];
  source: DecisionSource;
}

const HEADING = /^## D-(\d+) — (\d{4}-\d{2}-\d{2}) — (.+)$/;
const DECISION_PREFIX = "- **Decision:** ";
const REJECTED_PREFIX = "- **Rejected:** ";
const SOURCE_PREFIX = "- **Source:** ";

export function formatDecisionId(id: number): string {
  return `D-${String(id).padStart(3, "0")}`;
}

/**
 * The markdown IS the store. Anything that would make ID assignment a guess
 * (bad heading, missing Decision/Source, unknown source) is a hard error.
 */
export function parseDecisions(content: string): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  let current: { id: number; date: string; title: string; decision: string | null; rejected: string[]; source: DecisionSource | null } | null = null;

  const finalize = (): void => {
    if (current === null) return;
    if (current.decision === null || current.source === null) {
      throw new Error(
        `${DECISIONS_FILE}: ${formatDecisionId(current.id)} is missing its **Decision:** or **Source:** line; fix the file by hand`,
      );
    }
    entries.push({ ...current, decision: current.decision, source: current.source });
  };

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      finalize();
      const m = HEADING.exec(line);
      const [, id, date, title] = m ?? [];
      if (id === undefined || date === undefined || title === undefined) {
        throw new Error(
          `${DECISIONS_FILE}: unparseable heading "${line}"; expected "## D-NNN — YYYY-MM-DD — title" — fix the file by hand`,
        );
      }
      current = { id: Number(id), date, title, decision: null, rejected: [], source: null };
      continue;
    }
    if (current === null) continue; // preamble before the first entry
    if (line.startsWith(DECISION_PREFIX)) {
      current.decision = line.slice(DECISION_PREFIX.length);
    } else if (line.startsWith(REJECTED_PREFIX)) {
      current.rejected.push(line.slice(REJECTED_PREFIX.length));
    } else if (line.startsWith(SOURCE_PREFIX)) {
      const source = line.slice(SOURCE_PREFIX.length).trim();
      if (source !== "human" && source !== "workflow") {
        throw new Error(`${DECISIONS_FILE}: ${formatDecisionId(current.id)} has source "${source}"; expected human or workflow`);
      }
      current.source = source;
    }
  }
  finalize();
  return entries;
}

export async function readDecisions(repoDir: string): Promise<DecisionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoDir, DECISIONS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseDecisions(raw);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Append-only by design: no edit, no delete. Returns the assigned ID (e.g. "D-004"). */
export async function appendDecision(
  repoDir: string,
  entry: NewDecision,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<string> {
  const title = oneLine(entry.title);
  if (title.length === 0) throw new Error("decision title must not be blank");

  const target = join(repoDir, DECISIONS_FILE);
  let existing: string;
  try {
    existing = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "# Decisions\n";
  }
  const parsed = parseDecisions(existing); // throws before any write on a corrupt file
  const nextId = parsed.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  const id = formatDecisionId(nextId);

  const rejectedLines = entry.rejected.map((r) => `${REJECTED_PREFIX}${oneLine(r)}\n`).join("");
  const block =
    `\n## ${id} — ${date} — ${title}\n\n` +
    `${DECISION_PREFIX}${oneLine(entry.decision)}\n` +
    rejectedLines +
    `${SOURCE_PREFIX}${entry.source}\n`;

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, base + block);
  await rename(tmp, target);
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/decisions-store.test.ts`
Expected: PASS (10 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/store.ts test/decisions-store.test.ts
git commit -m "Add decisions.md parse and append store"
```

---

### Task 9: `tackle decision add` / `tackle decision list`

**Files:**
- Modify: `src/cli.ts` (add `registerDecisionCommands`, call it in `buildProgram`)
- Test: `test/cli-decision.test.ts`

**Interfaces:**
- Consumes: `appendDecision`, `readDecisions`, `formatDecisionId`, `DECISIONS_FILE` (Task 8).
- Produces:
  - `tackle decision add <title> --decision <text> [--rejected <text>]... [--cwd <dir>]` — `--decision` required, `--rejected` repeatable; source is always `human` from the CLI; prints the assigned ID.
  - `tackle decision list [--cwd <dir>]` — one line per entry: ID, date, title, source.
  - No edit, no delete.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli-decision.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { DECISIONS_FILE, readDecisions } from "../src/decisions/store.js";
import { tempWorkdir } from "./helpers/workflow.js";

async function run(args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return out.join("");
}

describe("tackle decision", () => {
  it("add appends with sequential IDs and repeatable --rejected; source is human", async () => {
    const dir = await tempWorkdir();
    const first = await run(["decision", "add", "Pick JSONL", "--decision", "ledger is JSONL", "--cwd", dir]);
    expect(first).toContain("D-001");
    await run([
      "decision", "add", "Second", "--decision", "did it",
      "--rejected", "alt one", "--rejected", "alt two", "--cwd", dir,
    ]);
    const entries = await readDecisions(dir);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(entries[1]?.rejected).toEqual(["alt one", "alt two"]);
    expect(entries.every((e) => e.source === "human")).toBe(true);
  });

  it("add requires --decision", async () => {
    const dir = await tempWorkdir();
    await expect(run(["decision", "add", "t", "--cwd", dir])).rejects.toThrow();
  });

  it("add refuses on an unparseable file with a clear error", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), "## broken\n");
    await expect(run(["decision", "add", "t", "--decision", "d", "--cwd", dir])).rejects.toThrow(/unparseable/);
  });

  it("list prints one line per entry: ID, date, title, source", async () => {
    const dir = await tempWorkdir();
    await run(["decision", "add", "Pick JSONL", "--decision", "d", "--cwd", dir]);
    const text = await run(["decision", "list", "--cwd", dir]);
    expect(text).toMatch(/D-001\s+\d{4}-\d{2}-\d{2}\s+Pick JSONL\s+\(human\)/);
  });

  it("list on no file says so", async () => {
    const dir = await tempWorkdir();
    expect(await run(["decision", "list", "--cwd", dir])).toContain("no decisions recorded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli-decision.test.ts`
Expected: FAIL — `unknown command 'decision'`.

- [ ] **Step 3: Implement the command group**

In `src/cli.ts`, add import:

```ts
import { appendDecision, DECISIONS_FILE, formatDecisionId, readDecisions } from "./decisions/store.js";
```

Add a registration function (near `registerTelemetryCommand`):

```ts
function registerDecisionCommands(program: Command, writeOut: (s: string) => void): void {
  const decision = program.command("decision").description(`Append-only decision log (${DECISIONS_FILE})`);
  const collect = (value: string, previous: string[]): string[] => [...previous, value];

  decision
    .command("add")
    .description("Append a decision entry")
    .argument("<title>", "one-line title")
    .requiredOption("--decision <text>", "what was decided")
    .option("--rejected <text>", "a rejected alternative (repeatable)", collect, [] as string[])
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (title: string, options: { decision: string; rejected: string[]; cwd: string }) => {
      const id = await appendDecision(options.cwd, {
        title,
        decision: options.decision,
        rejected: options.rejected,
        source: "human",
      });
      writeOut(`${id} recorded in ${DECISIONS_FILE}\n`);
    });

  decision
    .command("list")
    .description("List decision entries, one line each")
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const entries = await readDecisions(options.cwd);
      if (entries.length === 0) {
        writeOut(`no decisions recorded (${DECISIONS_FILE})\n`);
        return;
      }
      for (const e of entries) {
        writeOut(`${formatDecisionId(e.id)}  ${e.date}  ${e.title}  (${e.source})\n`);
      }
    });
}
```

In `buildProgram`, after `registerTelemetryCommand(program, writeOut);` add:

```ts
registerDecisionCommands(program, writeOut);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli-decision.test.ts`
Expected: PASS (5 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-decision.test.ts
git commit -m "Add tackle decision add and list commands"
```

---

### Task 10: Auto-record decisions at the review gate

**Files:**
- Modify: `src/workflow/types.ts` (`PhaseState`: two new optional review-only fields)
- Modify: `src/workflow/review.ts` (`finish()` inside `reviewLoop` stores round/escalation facts; `commitReviewed` appends the decision after a successful commit)
- Test: `test/review-decisions.test.ts`

**Interfaces:**
- Consumes: `appendDecision` (Task 8); existing `reviewLoop`/`commitReviewed`/`RoundRecord`/`blockingFindings` in review.ts.
- Produces:
  - `PhaseState.reviewRounds?: number` and `PhaseState.escalatedFindings?: string[]` (persisted in workflow.json so a resumed gate still records correctly).
  - Exactly two auto-record events, both `source: "workflow"`, written through `appendDecision` **after** the commit succeeds:
    1. Normal commit: title = request's first line; decision = `` committed `<sha10>` after N review round(s) ``; no rejected alternatives.
    2. Escalated approval (circuit breaker or budget exhausted): decision additionally carries `` , despite M unresolved blocking finding(s): <summaries joined by "; "> ``; rejected = `["reject and discard the review"]`.
  - A failed decision write warns via `presenter.inform` and does NOT change the outcome — the commit already happened.

- [ ] **Step 1: Write the failing test**

```ts
// test/review-decisions.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDecisions, DECISIONS_FILE } from "../src/decisions/store.js";
import { runReviewPhase } from "../src/workflow/review.js";
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

function reviewerSaying(summary: string, diff: string) {
  return scriptedAdapter([
    async () => fakeTurn({ summary, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
  ]);
}
const unusedAuthor = () => scriptedAdapter([async () => fakeTurn()]);

describe("review-gate decision auto-record", () => {
  it("a clean commit records one workflow-source entry with the sha and round count", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir, { request: "add widget\nwith details" });
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("add widget"); // first line only
    expect(entries[0]?.source).toBe("workflow");
    expect(entries[0]?.decision).toMatch(/committed `[0-9a-f]{10}` after 1 review round\(s\)/);
    expect(entries[0]?.rejected).toEqual([]);
  });

  it("an escalated approval records the knowingly-accepted findings and the rejected alternative", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // zero fix budget: round 1 escalates straight to the gate
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: 0 }));
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toMatch(/despite 1 unresolved blocking finding\(s\): bad/);
    expect(entries[0]?.rejected).toEqual(["reject and discard the review"]);
    expect(entries[0]?.source).toBe("workflow");
  });

  it("a rejected gate records nothing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    expect(await readDecisions(dir)).toEqual([]);
  });

  it("a resumed escalated gate still records the escalation facts", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: 0 }));
    // first run: human rejects the escalation -> awaiting_approval persists
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: rejectAll });
    // resume: no new reviewer turn; approve commits and records
    const throwingReviewer = scriptedAdapter([async () => { throw new Error("must not run a turn on resume"); }]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: throwingReviewer, author: unusedAuthor(), presenter: approveAll });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries[0]?.decision).toMatch(/despite 1 unresolved blocking finding\(s\): bad/);
  });

  it("a decision-write failure warns but the commit stands", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // pre-corrupt decisions.md so appendDecision throws
    await writeFile(join(dir, DECISIONS_FILE), "## broken heading\n");
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("approved");
    expect(presenter.messages.join("\n")).toContain("decision entry not recorded");
    // the file was not clobbered and the commit exists
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toBe("## broken heading\n");
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["log", "--oneline"])).toContain("add widget");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/review-decisions.test.ts`
Expected: FAIL — `readDecisions` returns `[]` after a committing run (`expected [] to have a length of 1`).

- [ ] **Step 3: Implement**

`src/workflow/types.ts` — add to `PhaseState` (after `gateDetail`):

```ts
  /** review only: number of reviewer rounds recorded in review.md, for the auto-decision entry. */
  reviewRounds?: number;
  /** review only: blocking-finding one-line summaries carried into an escalated gate. */
  escalatedFindings?: string[];
```

`src/workflow/review.ts` — add import:

```ts
import { appendDecision } from "../decisions/store.js";
```

In `reviewLoop`'s `finish` closure, extend the state write (`blocking` is in scope):

```ts
    const finish = async (escalation?: string): Promise<PhaseOutcome> => {
      await writeFile(join(workdir, SPINE.review.artifact), renderReviewMd(rounds, escalation));
      state.phases.review = {
        status: "awaiting_approval",
        lastTurn: toTurnRecord(result),
        reviewedDiffHash: sha256(currentDiff),
        reviewRounds: rounds.length,
        ...(escalation === undefined
          ? {}
          : { gateDetail: escalation, escalatedFindings: blocking.map((f) => f.summary) }),
      };
      await writeWorkflowState(workdir, state);
      return presentReviewGateAndCommit(workdir, state, presenter, escalation);
    };
```

In `commitReviewed`, after `presenter.inform(\`committed ${sha.slice(0, 10)}\`);` and before `return "approved";`:

```ts
  // Auto-record the decision-shaped moment (SPEC decisions.md). The commit
  // already happened: a failed write warns and never changes the outcome.
  try {
    const firstLine = state.request.split("\n")[0] ?? state.request;
    const escalated = review.escalatedFindings ?? [];
    const base = `committed \`${sha.slice(0, 10)}\` after ${review.reviewRounds ?? 1} review round(s)`;
    await appendDecision(
      workdir,
      escalated.length > 0
        ? {
            title: firstLine,
            decision: `${base}, despite ${escalated.length} unresolved blocking finding(s): ${escalated.join("; ")}`,
            rejected: ["reject and discard the review"],
            source: "workflow",
          }
        : { title: firstLine, decision: base, rejected: [], source: "workflow" },
    );
  } catch (err) {
    presenter.inform(`warning: decision entry not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/review-decisions.test.ts test/review.test.ts`
Expected: PASS — including the pre-existing review suite (the new state fields are optional; existing tests don't assert exact `phases.review` shape). Full suite `npx vitest run` green; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/types.ts src/workflow/review.ts test/review-decisions.test.ts
git commit -m "Auto-record decisions at review commit and escalated approval"
```

---

### Task 11: Repo gitignore negation + end-to-end suite

**Files:**
- Modify: `.gitignore` (this repo)
- Test: `test/telemetry-e2e.test.ts`

**Interfaces:**
- Consumes: everything above, through `buildProgram` with fake-adapter injection only.
- Produces: the spec's e2e evidence — a full fake workflow committing, ledger lines with correct contexts, the report over them, and the auto-recorded decision entry — plus this repo's decisions.md survives clones.

- [ ] **Step 1: Apply the gitignore negation**

In `.gitignore`, replace the line `.tackle/` with:

```gitignore
.tackle/*
!.tackle/decisions.md
```

(`.tackle/` must become `.tackle/*`: git cannot re-include a child of an ignored **directory**, only of an ignored glob.)

- [ ] **Step 2: Verify the negation with git itself**

Run:

```bash
git check-ignore -q .tackle/telemetry/turns.jsonl && echo telemetry-ignored
git check-ignore -q .tackle/decisions.md || echo decisions-tracked
git check-ignore -q .tackle/workflow.json && echo state-ignored
```

Expected output, exactly these three lines: `telemetry-ignored`, `decisions-tracked`, `state-ignored`.

- [ ] **Step 3: Write the failing e2e test**

```ts
// test/telemetry-e2e.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, resolveHead } from "../src/adapter/diff.js";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { readDecisions } from "../src/decisions/store.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { approveAll, fakeTurn, scriptedAdapter, tempGitRepo } from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const TOKENS = { inputTokens: 1_000_000, cacheReadInputTokens: 500_000, outputTokens: 200_000, reasoningOutputTokens: 50_000 };

/** Plays each phase by keying on the prompt's "running the <phase> phase" marker (spine-e2e pattern). */
function phasePlayingAdapter(): Adapter {
  return {
    name: "codex",
    run: async (req: TurnRequest) => {
      const t = join(req.workdir, ".tackle");
      await mkdir(t, { recursive: true });
      const usage = { tokens: TOKENS, billingType: "subscription" as const };
      const authorship = { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" as const };
      if (req.prompt.includes("running the specs phase")) {
        await writeFile(join(t, "specs.md"), "# specs: widget\n");
        return fakeTurn({ summary: "wrote specs", usage, authorship });
      }
      if (req.prompt.includes("running the plan phase")) {
        await writeFile(join(t, "plan.md"), "# plan: add w.ts\n");
        return fakeTurn({ summary: "wrote plan", usage, authorship });
      }
      if (req.prompt.includes("running the build phase")) {
        await writeFile(join(t, "build-notes.md"), "# notes\n");
        await writeFile(join(req.workdir, "w.ts"), "export const w = 1;\n");
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({ summary: "built it", workdirDiff, usage, authorship });
      }
      if (req.prompt.includes("running the pr phase")) {
        await writeFile(join(t, "pr.md"), "# PR\n");
        return fakeTurn({ summary: "wrote pr", usage, authorship });
      }
      throw new Error(`unrecognized phase prompt: ${req.prompt.slice(0, 80)}`);
    },
  };
}

function liveCleanReviewer() {
  return scriptedAdapter(
    [
      async (req: TurnRequest) => {
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({
          summary: CLEAN,
          workdirDiff,
          authorship: { adapter: "claude-code", model: null, effort: "medium" },
          usage: { tokens: TOKENS, billingType: "subscription" },
        });
      },
    ],
    "claude-code",
  );
}

describe("telemetry + decisions end to end", () => {
  it("full workflow: per-turn ledger, report over it, and the auto-recorded decision", async () => {
    const dir = await tempGitRepo();
    const out: string[] = [];
    const program = buildProgram({
      adapter: phasePlayingAdapter(),
      reviewerAdapter: liveCleanReviewer(),
      presenter: approveAll,
      writeOut: (s) => out.push(s),
    });
    program.exitOverride();

    await program.parseAsync(["specs", "ship the widget", "--cwd", dir], { from: "user" });
    await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
    await program.parseAsync(["build", "--cwd", dir], { from: "user" });
    await program.parseAsync(["review", "--cwd", dir], { from: "user" });
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });

    // one ledger line per turn, correct contexts, in order
    const { records, malformed } = await readTurnRecords(dir);
    expect(malformed).toBe(0);
    expect(records.map((r) => r.context)).toEqual([
      "phase:specs",
      "phase:plan",
      "phase:build",
      "review:reviewer",
      "phase:pr",
    ]);
    // the build turn carried real file stats
    const build = records[2];
    expect(build?.filesTouched.map((f) => f.path)).toContain("w.ts");

    // report over the ledger: turns, models, cost, churn all present
    out.length = 0;
    await program.parseAsync(["telemetry", "--cwd", dir, "--json"], { from: "user" });
    const report = JSON.parse(out.join(""));
    expect(report.turns).toBe(5);
    expect(report.byContext["review:reviewer"].turns).toBe(1);
    expect(Object.keys(report.tokens.byModel).sort()).toEqual(["claude-sonnet-4-5", "gpt-5.1-codex"]);
    expect(report.cost.totalUsd).toBeGreaterThan(0);
    expect(report.cost.unpriced).toEqual([]);
    expect(report.billing.subscription.turns).toBe(5);

    // the workflow commit auto-recorded exactly one decision entry
    const decisions = await readDecisions(dir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.title).toBe("ship the widget");
    expect(decisions[0]?.source).toBe("workflow");
    expect(decisions[0]?.decision).toMatch(/committed `[0-9a-f]{10}` after 1 review round\(s\)/);

    // and `tackle decision list` shows it
    out.length = 0;
    await program.parseAsync(["decision", "list", "--cwd", dir], { from: "user" });
    expect(out.join("")).toContain("ship the widget");
  });
});
```

- [ ] **Step 4: Run the e2e test**

Run: `npx vitest run test/telemetry-e2e.test.ts`
Expected: PASS. (If it fails, the failure is a real integration bug from Tasks 6–10 — debug there, do not weaken the assertions.)

- [ ] **Step 5: Full verification**

Run: `npx vitest run && npx tsc --noEmit && pnpm build`
Expected: entire suite green, typecheck clean, build clean.

- [ ] **Step 6: Commit**

```bash
git add .gitignore test/telemetry-e2e.test.ts
git commit -m "Negate decisions.md from .tackle gitignore; add telemetry e2e"
```

---

## Spec-coverage map (self-review)

| Spec requirement | Task |
|---|---|
| `recordedRun` seam, one-line swap, duration capture | 3, 7 |
| Four call sites with context tags; evals untouched | 7 |
| Telemetry failure never fails the turn | 3 (test: failed append) |
| `turn-record/v1` shape; no content stored | 2, 3 |
| `filesTouched` from workdirDiff, hardened parsing | 1, 3 |
| Append-only JSONL, per-repo, gitignored | 2, 11 |
| `tackle telemetry` `--cwd/--json/--since`; forgiving reader | 6 |
| Report: turns, tokens, billing, metered-equivalent cost, churn | 5 |
| Pricing table + `asOf` footer + default-model mapping + loud `unpriced` | 4, 5 |
| decisions.md format, markdown-is-the-store, max-ID+1, atomic write, parse-blocks-add | 8 |
| `tackle decision add/list`, no edit/delete | 9 |
| Auto-record: workflow commit + escalated approval only, via the same append path | 10 |
| Commit-flow keeps excluding `.tackle/`; repo gitignore negation | 11 (tackle-side behavior already exists, verified by review.test.ts "never commits .tackle") |
| Error-handling summary (5 bullets) | 3, 5/6, 1/3, 4/5, 8/10 respectively |
| Testing: unit per module + e2e through `buildProgram`, escalation path, no live turns | 1–10 + 11 (escalation entry shape covered in Task 10) |

v1 exclusions (trend history, cross-repo aggregation, transcript-derived friction, eval telemetry, edit/supersede) are deliberately absent.
