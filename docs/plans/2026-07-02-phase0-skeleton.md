# Phase 0 Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript CLI that runs one turn through the Codex CLI on subscription auth and returns a graded `TurnResult` envelope — the adapter-line contract from SPEC.md, made real.

**Architecture:** A `tackle turn` command drives the Codex CLI as a subprocess (`codex exec --json`, prompt on stdin), parses its JSONL stream, and normalizes everything into `TurnResult` (closed status enum, git diff as artifact of record, transcript on disk, authorship, usage with billing type). Adapters follow Sandcastle's provider decomposition per decision D-002: command builder + line parser + usage normalizer, with execution owned by the harness. Env is allowlist-built per adapter so the billing gate is structural.

**Tech Stack:** Node >= 22 (dev machine: v26), pnpm, TypeScript (strict, ESM/NodeNext), vitest, commander. No other runtime deps.

**Covers beads:** tackle-0q9 (scaffold), tackle-xh5 (TurnResult contract), tackle-mep (Codex adapter). The workflow spine (tackle-atq), review gate (tackle-483), and dependency-map builder (tackle-5lk) are follow-up plans.

## Global Constraints

- SPEC.md invariants: `status` is a closed enum `completed | refused | timeout | tool_error | budget_exceeded`; the diff, not the transcript, is the artifact of record; transcripts live on disk, never inlined; `billing_type` rides in the envelope on every turn.
- Effort bands are `low | medium | high` — agent/turn specs never name a model (SPEC.md "Model and effort routing"). `model` is an optional override resolved by config, `null` in authorship means backend default.
- Banned env keys may never reach an adapter subprocess: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_KEY`. A stray key is a thrown error, not a warning (SPEC.md design principle 3).
- Codex CLI recipes come from the Sandcastle spike (docs/spikes/2026-07-02-sandcastle.md): prompt over stdin (argv ~128KB limit), errors arrive on stdout, `cached_input_tokens` normalizes to cache-read with the remainder as input.
- Real captured stream shape (codex-cli 0.142.4, 2026-07-02): `thread.started`, `turn.started`, `item.completed` (with `item.type: "agent_message"`), `turn.completed` (with `usage: {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`).
- `~/.codex/auth.json` has `auth_mode: "chatgpt"` on subscription auth; `apikey` is the metered mode.
- All state written by the harness goes under `.tackle/` in the target workdir.
- Commit after every task. Don't mention Claude in commit messages.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts
src/
  cli.ts                 CLI entry (commander): tackle --version, tackle turn
  adapter/
    types.ts             TurnResult, TurnRequest, Adapter, Effort, TokenUsage, BillingType
    env.ts               buildAdapterEnv: allowlist env construction, banned-key guard
    exec.ts              runCommand: spawn wrapper (stdin, per-line stream, timeout)
    diff.ts              resolveHead + captureWorkdirDiff (diff vs pre-turn ref, incl. untracked)
    codex/
      command.ts         buildPrintCommand: codex exec --json argv + stdin
      stream.ts          parseStreamLine + normalizeUsage
      billing.ts         detectBillingType from env + auth.json
      index.ts           CodexAdapter: wires all of the above into run() -> TurnResult
test/
  fakes/
    package.json         {"type":"commonjs"} island
    codex                executable fake replaying fixture JSONL (FAKE_CODEX_* env knobs)
  fixtures/
    codex-completed.jsonl   the real captured stream
    codex-failed.jsonl      error-shaped stream
  *.test.ts              one test file per src module
```

---

### Task 1: Package scaffold and CLI entry

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/cli.ts`, `test/cli.test.ts`, `.gitignore` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `buildProgram(): Command` exported from `src/cli.ts` (commander `Command` with name `tackle`, version from package.json); `pnpm test` and `pnpm build` work

- [ ] **Step 1: Scaffold the package**

```bash
pnpm init
pnpm add commander
pnpm add -D typescript vitest tsx @types/node
```

Then overwrite `package.json` fields (keep the generated lockfile-relevant bits):

```json
{
  "name": "tackle-harness",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "tackle": "./dist/cli.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "commander": "^14.0.0" },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

(Use whatever versions `pnpm add` actually resolved — do not downgrade them to match the JSON above.)

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
```

Append to `.gitignore`:

```
node_modules/
dist/
.tackle/
```

- [ ] **Step 2: Write the failing test**

`test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli", () => {
  it("is named tackle and has a version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("tackle");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/cli.js`

- [ ] **Step 4: Write minimal implementation**

`src/cli.ts`:

```ts
import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);
  return program;
}

const isMain = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isMain) {
  buildProgram().parseAsync(process.argv);
}
```

- [ ] **Step 5: Run test and typecheck to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Also sanity-check: `pnpm dev --version` prints `0.0.1`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/cli.ts test/cli.test.ts .gitignore
git commit -m "Scaffold tackle-harness TypeScript CLI (commander, vitest, strict ESM)"
```

---

### Task 2: Adapter types and the env allowlist builder

**Files:**
- Create: `src/adapter/types.ts`, `src/adapter/env.ts`, `test/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (types.ts — exact, later tasks import these):

```ts
export type Effort = "low" | "medium" | "high";
export type TurnStatus = "completed" | "refused" | "timeout" | "tool_error" | "budget_exceeded";
export type BillingType = "subscription" | "metered" | "unknown";

export interface TokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface Authorship {
  adapter: string;
  model: string | null; // null = backend default model
  effort: Effort;
  stackProfile?: string;
}

export interface TurnResult {
  status: TurnStatus;
  workdirDiff: string;
  transcriptRef: string;
  summary: string;
  sessionId: string | null;
  authorship: Authorship;
  usage: { tokens: TokenUsage; billingType: BillingType };
}

export interface TurnRequest {
  prompt: string;
  workdir: string;
  effort: Effort;
  model?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
}

export interface Adapter {
  readonly name: string;
  run(req: TurnRequest): Promise<TurnResult>;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
```

- Produces (env.ts): `BANNED_ENV_KEYS: readonly string[]`; `class AdapterEnvError extends Error`; `buildAdapterEnv(opts: { base: Record<string, string | undefined>; allow: string[]; extra?: Record<string, string> }): Record<string, string>`

- [ ] **Step 1: Write the failing tests**

`test/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AdapterEnvError, buildAdapterEnv } from "../src/adapter/env.js";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/g",
  ANTHROPIC_API_KEY: "sk-leak",
  OPENAI_API_KEY: "sk-leak2",
  RANDOM_SECRET: "shh",
};

describe("buildAdapterEnv", () => {
  it("includes only allowlisted keys from base", () => {
    const env = buildAdapterEnv({ base, allow: ["PATH", "HOME"] });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/g" });
  });

  it("skips allowlisted keys that are undefined in base", () => {
    const env = buildAdapterEnv({ base: { PATH: "/usr/bin", HOME: undefined }, allow: ["PATH", "HOME"] });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("merges extra keys", () => {
    const env = buildAdapterEnv({ base, allow: ["PATH"], extra: { FAKE_CODEX_FIXTURE: "/f.jsonl" } });
    expect(env).toEqual({ PATH: "/usr/bin", FAKE_CODEX_FIXTURE: "/f.jsonl" });
  });

  it("throws when an extra key collides with an allowlisted base key", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH"], extra: { PATH: "/evil" } })).toThrow(AdapterEnvError);
  });

  it("throws when a banned key is allowlisted", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH", "ANTHROPIC_API_KEY"] })).toThrow(AdapterEnvError);
  });

  it("throws when a banned key arrives via extra", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH"], extra: { OPENAI_API_KEY: "x" } })).toThrow(AdapterEnvError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/env.js`

- [ ] **Step 3: Write the implementation**

`src/adapter/types.ts`: exactly the block in "Produces" above.

`src/adapter/env.ts`:

```ts
export const BANNED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_KEY",
] as const;

export class AdapterEnvError extends Error {}

export function buildAdapterEnv(opts: {
  base: Record<string, string | undefined>;
  allow: string[];
  extra?: Record<string, string>;
}): Record<string, string> {
  const banned = new Set<string>(BANNED_ENV_KEYS);
  const env: Record<string, string> = {};

  for (const key of opts.allow) {
    if (banned.has(key)) {
      throw new AdapterEnvError(`banned env key allowlisted: ${key}`);
    }
    const value = opts.base[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (banned.has(key)) {
      throw new AdapterEnvError(`banned env key in extra: ${key}`);
    }
    if (key in env) {
      throw new AdapterEnvError(`extra env key collides with allowlisted base key: ${key}`);
    }
    env[key] = value;
  }

  return env;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapter/types.ts src/adapter/env.ts test/env.test.ts
git commit -m "Add TurnResult contract types and allowlist env builder with banned-key guard"
```

---

### Task 3: Subprocess runner with stdin, line streaming, and timeout

**Files:**
- Create: `src/adapter/exec.ts`, `test/exec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface ExecResult { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }`; `runCommand(opts: { cmd: string; args: string[]; stdin?: string; cwd: string; env: Record<string, string>; timeoutMs: number; onLine?: (line: string) => void }): Promise<ExecResult>`

- [ ] **Step 1: Write the failing tests**

`test/exec.test.ts` (uses `node -e` scripts as the subprocess — no fixtures needed):

```ts
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/adapter/exec.js";

const nodeEnv = { PATH: process.env.PATH ?? "" };

describe("runCommand", () => {
  it("captures exit code, stdout, and per-line callbacks", async () => {
    const lines: string[] = [];
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `console.log("one"); console.log("two");`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
      onLine: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(lines).toEqual(["one", "two"]);
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("pipes stdin to the child", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `process.stdin.pipe(process.stdout);`],
      stdin: "hello from stdin",
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe("hello from stdin");
  });

  it("reports nonzero exit codes and stderr", async () => {
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `console.error("boom"); process.exit(3);`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("kills the child and flags timedOut on timeout", async () => {
    const start = Date.now();
    const result = await runCommand({
      cmd: process.execPath,
      args: ["-e", `setTimeout(() => {}, 60_000);`],
      cwd: process.cwd(),
      env: nodeEnv,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/exec.js`

- [ ] **Step 3: Write the implementation**

`src/adapter/exec.ts`:

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export async function runCommand(opts: {
  cmd: string;
  args: string[];
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onLine?: (line: string) => void;
}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts.onLine) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", opts.onLine);
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
```

Note: attaching both a `data` listener and a `readline` interface to the same stream is fine — readline consumes the same events; neither pauses the stream.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (timeout test finishes in well under 5s)

- [ ] **Step 5: Commit**

```bash
git add src/adapter/exec.ts test/exec.test.ts
git commit -m "Add subprocess runner with stdin piping, line streaming, and hard timeout"
```

---

### Task 4: Workdir diff capture

**Files:**
- Create: `src/adapter/diff.ts`, `test/diff.test.ts`

**Interfaces:**
- Consumes: nothing (uses `node:child_process` directly — git calls are short and untimed)
- Produces: `resolveHead(workdir: string): Promise<string>` (returns full SHA); `captureWorkdirDiff(workdir: string, baseRef: string): Promise<string>` (unified diff of tracked changes vs `baseRef` plus `/dev/null`-style diffs for untracked files; empty string when clean)

- [ ] **Step 1: Write the failing tests**

`test/diff.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, resolveHead } from "../src/adapter/diff.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-diff-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "original\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("workdir diff", () => {
  it("resolves HEAD to a full sha", async () => {
    const dir = makeRepo();
    expect(await resolveHead(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns empty string for a clean workdir", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    expect(await captureWorkdirDiff(dir, base)).toBe("");
  });

  it("captures tracked modifications against the base ref", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("-original");
    expect(diff).toContain("+changed");
  });

  it("captures untracked files as new-file diffs", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "brand-new.txt"), "fresh\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("brand-new.txt");
    expect(diff).toContain("+fresh");
  });

  it("captures commits the turn made (diff vs pre-turn ref)", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
    writeFileSync(join(dir, "a.txt"), "committed change\n");
    git("add", ".");
    git("commit", "-q", "-m", "agent commit");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("+committed change");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/diff.js`

- [ ] **Step 3: Write the implementation**

`src/adapter/diff.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(workdir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workdir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function resolveHead(workdir: string): Promise<string> {
  return (await git(workdir, ["rev-parse", "HEAD"])).trim();
}

export async function captureWorkdirDiff(workdir: string, baseRef: string): Promise<string> {
  const tracked = await git(workdir, ["diff", baseRef]);

  const untrackedList = (await git(workdir, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter((f) => f.length > 0);

  const untrackedDiffs: string[] = [];
  for (const file of untrackedList) {
    // git diff --no-index exits 1 when files differ; that is the expected case
    const diff = await git(workdir, ["diff", "--no-index", "--", "/dev/null", file]).catch(
      (err: { stdout?: string }) => err.stdout ?? "",
    );
    untrackedDiffs.push(diff);
  }

  return [tracked, ...untrackedDiffs].filter((d) => d.length > 0).join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapter/diff.ts test/diff.test.ts
git commit -m "Add workdir diff capture vs pre-turn ref, including untracked files"
```

---

### Task 5: Codex stream parser and usage normalization

**Files:**
- Create: `src/adapter/codex/stream.ts`, `test/codex-stream.test.ts`, `test/fixtures/codex-completed.jsonl`, `test/fixtures/codex-failed.jsonl`

**Interfaces:**
- Consumes: `TokenUsage`, `EMPTY_USAGE` from `src/adapter/types.ts`
- Produces:

```ts
export type CodexEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "error"; message: string }
  | { kind: "other"; raw: unknown };

export function parseStreamLine(line: string): CodexEvent | null; // null for blank/non-JSON lines
export function normalizeUsage(raw: {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}): TokenUsage;
```

- [ ] **Step 1: Create the fixtures**

`test/fixtures/codex-completed.jsonl` — the real capture from codex-cli 0.142.4:

```
{"type":"thread.started","thread_id":"019f23af-eb41-7b92-a92e-c4d44bb55af1"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}
{"type":"turn.completed","usage":{"input_tokens":13966,"cached_input_tokens":5504,"output_tokens":5,"reasoning_output_tokens":0}}
```

`test/fixtures/codex-failed.jsonl`:

```
{"type":"thread.started","thread_id":"019f23af-0000-0000-0000-c4d44bb55af1"}
{"type":"turn.started"}
{"type":"turn.failed","error":{"message":"stream error: unexpected status 401"}}
```

- [ ] **Step 2: Write the failing tests**

`test/codex-stream.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeUsage, parseStreamLine } from "../src/adapter/codex/stream.js";

const completedLines = readFileSync("test/fixtures/codex-completed.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.length > 0);

describe("parseStreamLine", () => {
  it("extracts the session id from thread.started", () => {
    expect(parseStreamLine(completedLines[0]!)).toEqual({
      kind: "session",
      sessionId: "019f23af-eb41-7b92-a92e-c4d44bb55af1",
    });
  });

  it("extracts agent message text from item.completed", () => {
    expect(parseStreamLine(completedLines[2]!)).toEqual({ kind: "message", text: "hi" });
  });

  it("extracts normalized usage from turn.completed", () => {
    expect(parseStreamLine(completedLines[3]!)).toEqual({
      kind: "usage",
      usage: {
        inputTokens: 13966 - 5504,
        cacheReadInputTokens: 5504,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
    });
  });

  it("extracts errors from turn.failed", () => {
    const line = readFileSync("test/fixtures/codex-failed.jsonl", "utf8").split("\n")[2]!;
    expect(parseStreamLine(line)).toEqual({
      kind: "error",
      message: "stream error: unexpected status 401",
    });
  });

  it("classifies unknown event types as other", () => {
    expect(parseStreamLine(`{"type":"item.started","item":{}}`)).toEqual({
      kind: "other",
      raw: { type: "item.started", item: {} },
    });
  });

  it("returns null for blank and non-JSON lines (errors arrive on stdout)", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("Reading additional input from stdin...")).toBeNull();
  });
});

describe("normalizeUsage", () => {
  it("splits cached tokens out of input to avoid double counting", () => {
    expect(
      normalizeUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 }),
    ).toEqual({ inputTokens: 60, cacheReadInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 2 });
  });

  it("tolerates missing optional fields", () => {
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 1 })).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/codex/stream.js`

- [ ] **Step 4: Write the implementation**

`src/adapter/codex/stream.ts`:

```ts
import type { TokenUsage } from "../types.js";

export type CodexEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "error"; message: string }
  | { kind: "other"; raw: unknown };

export function normalizeUsage(raw: {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}): TokenUsage {
  const cached = raw.cached_input_tokens ?? 0;
  return {
    inputTokens: raw.input_tokens - cached,
    cacheReadInputTokens: cached,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
  };
}

export function parseStreamLine(line: string): CodexEvent | null {
  if (line.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // codex mixes human-readable notices into stdout
  }
  const event = parsed as {
    type?: string;
    thread_id?: string;
    item?: { type?: string; text?: string };
    usage?: Parameters<typeof normalizeUsage>[0];
    error?: { message?: string };
  };

  switch (event.type) {
    case "thread.started":
      return event.thread_id ? { kind: "session", sessionId: event.thread_id } : { kind: "other", raw: parsed };
    case "item.completed":
      return event.item?.type === "agent_message" && typeof event.item.text === "string"
        ? { kind: "message", text: event.item.text }
        : { kind: "other", raw: parsed };
    case "turn.completed":
      return event.usage ? { kind: "usage", usage: normalizeUsage(event.usage) } : { kind: "other", raw: parsed };
    case "turn.failed":
      return { kind: "error", message: event.error?.message ?? "turn failed" };
    default:
      return { kind: "other", raw: parsed };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/adapter/codex/stream.ts test/codex-stream.test.ts test/fixtures/
git commit -m "Add codex JSONL stream parser with cached-token usage normalization"
```

---

### Task 6: Codex command builder

**Files:**
- Create: `src/adapter/codex/command.ts`, `test/codex-command.test.ts`

**Interfaces:**
- Consumes: `Effort` from `src/adapter/types.ts`
- Produces:

```ts
export interface PrintCommand { cmd: string; args: string[]; stdin: string }
export function buildPrintCommand(req: {
  prompt: string;
  effort: Effort;
  model?: string;
  resumeSessionId?: string;
}): PrintCommand;
```

- [ ] **Step 1: Write the failing tests**

`test/codex-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPrintCommand } from "../src/adapter/codex/command.js";

describe("buildPrintCommand", () => {
  it("builds a fresh exec command with prompt on stdin", () => {
    const cmd = buildPrintCommand({ prompt: "do the thing", effort: "medium" });
    expect(cmd.cmd).toBe("codex");
    expect(cmd.args).toEqual([
      "exec",
      "--json",
      "--full-auto",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
    expect(cmd.stdin).toBe("do the thing");
  });

  it("omits -m unless a model override is given (shipped-default invariant)", () => {
    const bare = buildPrintCommand({ prompt: "p", effort: "low" });
    expect(bare.args).not.toContain("-m");
    const pinned = buildPrintCommand({ prompt: "p", effort: "low", model: "gpt-5.2-codex" });
    expect(pinned.args).toContain("-m");
    expect(pinned.args[pinned.args.indexOf("-m") + 1]).toBe("gpt-5.2-codex");
  });

  it("uses the resume verb when resuming a session", () => {
    const cmd = buildPrintCommand({ prompt: "continue", effort: "high", resumeSessionId: "abc-123" });
    expect(cmd.args.slice(0, 3)).toEqual(["exec", "resume", "abc-123"]);
    expect(cmd.args).toContain("--json");
    expect(cmd.args[cmd.args.length - 1]).toBe("-");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/codex/command.js`

- [ ] **Step 3: Write the implementation**

`src/adapter/codex/command.ts`:

```ts
import type { Effort } from "../types.js";

export interface PrintCommand {
  cmd: string;
  args: string[];
  stdin: string;
}

export function buildPrintCommand(req: {
  prompt: string;
  effort: Effort;
  model?: string;
  resumeSessionId?: string;
}): PrintCommand {
  const args = req.resumeSessionId ? ["exec", "resume", req.resumeSessionId] : ["exec"];

  args.push("--json", "--full-auto", "--skip-git-repo-check");
  args.push("-c", `model_reasoning_effort="${req.effort}"`);
  if (req.model !== undefined) args.push("-m", req.model);
  args.push("-"); // read prompt from stdin: argv has a ~128KB limit, prompts don't

  return { cmd: "codex", args, stdin: req.prompt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapter/codex/command.ts test/codex-command.test.ts
git commit -m "Add codex exec command builder with stdin prompt and resume verb"
```

---

### Task 7: Billing-type detection

**Files:**
- Create: `src/adapter/codex/billing.ts`, `test/codex-billing.test.ts`

**Interfaces:**
- Consumes: `BillingType` from `src/adapter/types.ts`
- Produces: `detectBillingType(opts: { env: Record<string, string>; authPath: string }): Promise<BillingType>`

Logic (SPEC.md: credential precedence in the environment decides billing): an API key in the adapter env → `metered` regardless of auth.json (env wins). Otherwise `auth_mode === "chatgpt"` in auth.json → `subscription`; `auth_mode === "apikey"` → `metered`; unreadable/absent/unrecognized → `unknown`.

- [ ] **Step 1: Write the failing tests**

`test/codex-billing.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectBillingType } from "../src/adapter/codex/billing.js";

function authFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, contents);
  return path;
}

describe("detectBillingType", () => {
  it("reports subscription for chatgpt auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("subscription");
  });

  it("reports metered for apikey auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("metered");
  });

  it("env API key overrides subscription auth (credential precedence)", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "chatgpt" }));
    expect(await detectBillingType({ env: { OPENAI_API_KEY: "sk-x" }, authPath: path })).toBe("metered");
  });

  it("reports unknown when auth.json is missing", async () => {
    expect(await detectBillingType({ env: {}, authPath: "/nonexistent/auth.json" })).toBe("unknown");
  });

  it("reports unknown for unrecognized auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "device" }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/codex/billing.js`

- [ ] **Step 3: Write the implementation**

`src/adapter/codex/billing.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { BillingType } from "../types.js";

const ENV_KEY_NAMES = ["OPENAI_API_KEY", "OPENAI_KEY"];

export async function detectBillingType(opts: {
  env: Record<string, string>;
  authPath: string;
}): Promise<BillingType> {
  if (ENV_KEY_NAMES.some((k) => opts.env[k] !== undefined)) return "metered";

  let authMode: unknown;
  try {
    const raw = JSON.parse(await readFile(opts.authPath, "utf8")) as { auth_mode?: unknown };
    authMode = raw.auth_mode;
  } catch {
    return "unknown";
  }

  if (authMode === "chatgpt") return "subscription";
  if (authMode === "apikey") return "metered";
  return "unknown";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapter/codex/billing.ts test/codex-billing.test.ts
git commit -m "Add codex billing-type detection: env key precedence over auth.json mode"
```

---

### Task 8: The Codex adapter (wires everything into run() -> TurnResult)

**Files:**
- Create: `src/adapter/codex/index.ts`, `test/codex-adapter.test.ts`, `test/fakes/package.json`, `test/fakes/codex`

**Interfaces:**
- Consumes: everything produced by Tasks 2–7, exactly as specified there
- Produces:

```ts
export class CodexAdapter implements Adapter {
  readonly name = "codex";
  constructor(opts?: { baseEnv?: Record<string, string | undefined>; authPath?: string });
  run(req: TurnRequest): Promise<TurnResult>;
}
```

Behavior contract:
- Env: `buildAdapterEnv({ base: baseEnv ?? process.env, allow: ["PATH", "HOME"] })` — codex finds `~/.codex` via HOME; API keys are structurally absent.
- `authPath` defaults to `join(homedir(), ".codex", "auth.json")`.
- Transcript: raw stdout lines written to `<workdir>/.tackle/transcripts/<ISO-timestamp>-codex.jsonl` (directory created if needed); its path is `transcriptRef`.
- Diff: `resolveHead` before the turn, `captureWorkdirDiff` after.
- Status mapping: `timedOut` → `timeout`; any `error` event or nonzero/null exit → `tool_error`; else a `usage` event was seen → `completed`; else `tool_error`. (`refused` and `budget_exceeded` are reserved for the orchestrator/gates — this adapter never emits them yet.)
- `summary`: text of the last `message` event, else `""`. `sessionId`: from the `session` event, else `null`.
- `authorship`: `{ adapter: "codex", model: req.model ?? null, effort: req.effort }`.
- Default `timeoutMs`: 600_000.

- [ ] **Step 1: Create the fake codex binary**

`test/fakes/package.json`:

```json
{ "type": "commonjs" }
```

`test/fakes/codex` (then `chmod +x test/fakes/codex`):

```js
#!/usr/bin/env node
// Fake codex CLI: consumes stdin, replays a fixture, exits per env knobs.
const fs = require("node:fs");

process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const fixture = process.env.FAKE_CODEX_FIXTURE;
  if (fixture) process.stdout.write(fs.readFileSync(fixture, "utf8"));
  const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0);
  setTimeout(() => process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0)), sleepMs);
});
```

- [ ] **Step 2: Write the failing tests**

`test/codex-adapter.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter/codex/index.js";

const fakesDir = resolve("test/fakes");
const fixturesDir = resolve("test/fixtures");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-adapter-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "original\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

function makeAdapter(extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tackle-home-"));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  return new CodexAdapter({
    baseEnv: {
      PATH: `${fakesDir}:${process.env.PATH}`,
      HOME: home,
      ...extraEnv,
    },
    authPath: join(home, "auth.json"),
  });
}

describe("CodexAdapter", () => {
  it("grades a successful turn as completed with usage, session, summary, and billing", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "say hi", workdir, effort: "medium" });

    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("019f23af-eb41-7b92-a92e-c4d44bb55af1");
    expect(result.summary).toBe("hi");
    expect(result.usage.billingType).toBe("subscription");
    expect(result.usage.tokens).toEqual({
      inputTokens: 13966 - 5504,
      cacheReadInputTokens: 5504,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
    expect(result.authorship).toEqual({ adapter: "codex", model: null, effort: "medium" });
    expect(result.workdirDiff).toBe("");
  });

  it("writes the raw stream to a transcript file under .tackle/", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "say hi", workdir, effort: "low" });

    expect(result.transcriptRef).toContain(join(workdir, ".tackle", "transcripts"));
    expect(existsSync(result.transcriptRef)).toBe(true);
    expect(readFileSync(result.transcriptRef, "utf8")).toContain('"turn.completed"');
  });

  it("grades turn.failed as tool_error", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-failed.jsonl") });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.status).toBe("tool_error");
  });

  it("grades a nonzero exit as tool_error even with a complete stream", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({
      FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-completed.jsonl"),
      FAKE_CODEX_EXIT: "2",
    });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.status).toBe("tool_error");
  });

  it("grades a hung child as timeout", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({
      FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-completed.jsonl"),
      FAKE_CODEX_SLEEP_MS: "60000",
    });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium", timeoutMs: 1_000 });
    expect(result.status).toBe("timeout");
  });

  it("captures the diff when the turn changes files", async () => {
    const workdir = makeRepo();
    writeFileSync(join(workdir, "a.txt"), "changed by agent\n"); // simulate the turn's edit
    const adapter = makeAdapter({ FAKE_CODEX_FIXTURE: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.workdirDiff).toContain("+changed by agent");
  });
});
```

Note on the env knobs: the fake reads `FAKE_CODEX_*` from its own env, which the adapter builds via allowlist — so the test passes them through `baseEnv` and the adapter's allowlist must include them. That is wrong by design. Instead, the adapter's allowlist stays `["PATH", "HOME"]` and the fake reads its knobs from files: **revise the fake** to read knobs from `$HOME/.fake-codex.json` (HOME is allowlisted):

`test/fakes/codex` (final version):

```js
#!/usr/bin/env node
// Fake codex CLI: consumes stdin, replays a fixture, exits per $HOME/.fake-codex.json knobs.
const fs = require("node:fs");
const path = require("node:path");

let knobs = {};
try {
  knobs = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".fake-codex.json"), "utf8"));
} catch {}

process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (knobs.fixture) process.stdout.write(fs.readFileSync(knobs.fixture, "utf8"));
  setTimeout(() => process.exit(knobs.exitCode ?? 0), knobs.sleepMs ?? 0);
});
```

And in the test, replace `makeAdapter(extraEnv)` with knob-file writing:

```ts
function makeAdapter(knobs: { fixture?: string; exitCode?: number; sleepMs?: number }) {
  const home = mkdtempSync(join(tmpdir(), "tackle-home-"));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  writeFileSync(join(home, ".fake-codex.json"), JSON.stringify(knobs));
  return new CodexAdapter({
    baseEnv: { PATH: `${fakesDir}:${process.env.PATH}`, HOME: home },
    authPath: join(home, "auth.json"),
  });
}
```

…and each call site becomes e.g. `makeAdapter({ fixture: join(fixturesDir, "codex-completed.jsonl"), exitCode: 2 })`. Use the knob-file versions — they are the real test of the allowlist (a fake that needs env passthrough would prove the allowlist leaks).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `../src/adapter/codex/index.js`

- [ ] **Step 4: Write the implementation**

`src/adapter/codex/index.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildAdapterEnv } from "../env.js";
import { runCommand } from "../exec.js";
import { captureWorkdirDiff, resolveHead } from "../diff.js";
import type { Adapter, TurnRequest, TurnResult, TokenUsage } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { buildPrintCommand } from "./command.js";
import { parseStreamLine } from "./stream.js";
import { detectBillingType } from "./billing.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export class CodexAdapter implements Adapter {
  readonly name = "codex";
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly authPath: string;

  constructor(opts: { baseEnv?: Record<string, string | undefined>; authPath?: string } = {}) {
    this.baseEnv = opts.baseEnv ?? process.env;
    this.authPath = opts.authPath ?? join(homedir(), ".codex", "auth.json");
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const env = buildAdapterEnv({ base: this.baseEnv, allow: ["PATH", "HOME"] });
    const billingType = await detectBillingType({ env, authPath: this.authPath });
    const baseRef = await resolveHead(req.workdir);
    const command = buildPrintCommand({
      prompt: req.prompt,
      effort: req.effort,
      model: req.model,
      resumeSessionId: req.resumeSessionId,
    });

    const rawLines: string[] = [];
    let sessionId: string | null = null;
    let summary = "";
    let usage: TokenUsage | null = null;
    let errored = false;

    const exec = await runCommand({
      cmd: command.cmd,
      args: command.args,
      stdin: command.stdin,
      cwd: req.workdir,
      env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onLine: (line) => {
        rawLines.push(line);
        const event = parseStreamLine(line);
        if (event === null) return;
        if (event.kind === "session") sessionId = event.sessionId;
        if (event.kind === "message") summary = event.text;
        if (event.kind === "usage") usage = event.usage;
        if (event.kind === "error") errored = true;
      },
    });

    const transcriptDir = join(req.workdir, ".tackle", "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptRef = join(
      transcriptDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-codex.jsonl`,
    );
    await writeFile(transcriptRef, rawLines.join("\n") + "\n");

    const workdirDiff = await captureWorkdirDiff(req.workdir, baseRef);

    let status: TurnResult["status"];
    if (exec.timedOut) status = "timeout";
    else if (errored || exec.exitCode !== 0) status = "tool_error";
    else if (usage !== null) status = "completed";
    else status = "tool_error";

    return {
      status,
      workdirDiff,
      transcriptRef,
      summary,
      sessionId,
      authorship: { adapter: this.name, model: req.model ?? null, effort: req.effort },
      usage: { tokens: usage ?? EMPTY_USAGE, billingType },
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (the timeout test takes ~1s; suite stays under 15s)

- [ ] **Step 6: Commit**

```bash
chmod +x test/fakes/codex
git add src/adapter/codex/index.ts test/codex-adapter.test.ts test/fakes/
git commit -m "Add CodexAdapter: run() -> TurnResult with billing assertion and diff capture"
```

---

### Task 9: `tackle turn` CLI command

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli-turn.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter` from `src/adapter/codex/index.js`; `Effort` from `src/adapter/types.js`
- Produces: `tackle turn <prompt> [--cwd <dir>] [--effort low|medium|high] [--model <m>] [--timeout <seconds>]` — runs one turn, prints the full `TurnResult` as pretty JSON to stdout, exits 0 iff `status === "completed"`. `buildProgram(opts?: { adapter?: Adapter })` gains an optional adapter injection for tests.

- [ ] **Step 1: Write the failing test**

`test/cli-turn.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import type { Adapter, TurnResult } from "../src/adapter/types.js";

const fakeResult: TurnResult = {
  status: "completed",
  workdirDiff: "",
  transcriptRef: "/tmp/t.jsonl",
  summary: "done",
  sessionId: "s-1",
  authorship: { adapter: "codex", model: null, effort: "high" },
  usage: {
    tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    billingType: "subscription",
  },
};

describe("tackle turn", () => {
  it("runs the adapter with parsed options and prints the TurnResult", async () => {
    const run = vi.fn(async () => fakeResult);
    const adapter: Adapter = { name: "codex", run };
    const out: string[] = [];
    const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
    program.exitOverride();

    await program.parseAsync(["turn", "fix the bug", "--effort", "high", "--timeout", "30"], { from: "user" });

    expect(run).toHaveBeenCalledWith({
      prompt: "fix the bug",
      workdir: process.cwd(),
      effort: "high",
      model: undefined,
      timeoutMs: 30_000,
    });
    expect(JSON.parse(out.join(""))).toEqual(fakeResult);
  });

  it("rejects an invalid effort band", async () => {
    const adapter: Adapter = { name: "codex", run: vi.fn() };
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await expect(
      program.parseAsync(["turn", "p", "--effort", "ultra"], { from: "user" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `buildProgram` accepts no options / has no `turn` command

- [ ] **Step 3: Update the implementation**

Replace `src/cli.ts` with:

```ts
import { createRequire } from "node:module";
import { Command, InvalidArgumentError, Option } from "commander";
import { CodexAdapter } from "./adapter/codex/index.js";
import type { Adapter } from "./adapter/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(opts: { adapter?: Adapter; writeOut?: (s: string) => void } = {}): Command {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);

  program
    .command("turn")
    .description("Run a single turn through an adapter and print the TurnResult")
    .argument("<prompt>", "the prompt for the turn")
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .addOption(new Option("--effort <band>", "effort band").choices(["low", "medium", "high"]).default("medium"))
    .option("--model <model>", "model override (default: backend default)")
    .option("--timeout <seconds>", "turn timeout in seconds", (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("timeout must be a positive number");
      return n;
    })
    .action(async (prompt: string, options: { cwd: string; effort: "low" | "medium" | "high"; model?: string; timeout?: number }) => {
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

  return program;
}

const isMain = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isMain) {
  buildProgram().parseAsync(process.argv);
}
```

Note: the first test asserts `run` was called with `timeoutMs: 30_000` — the option parser converts seconds to ms; when `--timeout` is omitted, `timeoutMs` is `undefined` and the adapter's 600s default applies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (including the Task 1 cli test, unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-turn.test.ts
git commit -m "Add tackle turn command: one adapter turn, TurnResult JSON to stdout"
```

---

### Task 10: Real-turn smoke test (attended) and bead closeout

**Files:**
- Create: `docs/plans/2026-07-02-phase0-skeleton-notes.md` (smoke-run evidence)

This task is manual/attended — it burns one real subscription turn and verifies the whole stack against the live codex CLI (0.142.4). It also verifies two assumptions the fixtures can't: that `codex exec` accepts `-` + stdin as the prompt source, and that `--full-auto` lets the agent write files in the workdir.

- [ ] **Step 1: Build and prepare a scratch repo**

```bash
pnpm build
SCRATCH=$(mktemp -d /tmp/tackle-smoke-XXXX)
cd "$SCRATCH" && git init -q && git commit -q --allow-empty -m init && cd -
```

- [ ] **Step 2: Run a real file-writing turn**

```bash
node dist/cli.js turn "Create a file named hello.txt containing exactly the word: hello" \
  --cwd "$SCRATCH" --effort low --timeout 300
```

Expected: exit code 0; JSON on stdout with `status: "completed"`, `usage.billingType: "subscription"`, nonzero `usage.tokens.inputTokens`/`outputTokens`, a `sessionId` UUID, `workdirDiff` containing `+hello`, and `transcriptRef` pointing at an existing file under `$SCRATCH/.tackle/transcripts/`.

If the prompt never reaches codex (empty/odd behavior): the `-` + stdin assumption failed for this codex version — fall back to passing the prompt as the final argv element in `buildPrintCommand` (update Task 6's builder and tests), rerun. If no files were written: `--full-auto` sandbox blocked writes — check `codex exec --help` for the current sandbox flags and adjust the builder.

- [ ] **Step 3: Record the evidence**

Write `docs/plans/2026-07-02-phase0-skeleton-notes.md` containing: the exact command run, the full TurnResult JSON (redact nothing — no secrets appear in it), the codex CLI version, and any deviations found in Step 2. This is the spec's "measure or it didn't happen" applied to the harness itself.

- [ ] **Step 4: Close the beads and commit**

```bash
bd close tackle-0q9 --reason "Scaffold shipped: tackle CLI, vitest, strict ESM"
bd close tackle-xh5 --reason "TurnResult contract implemented and exercised by CodexAdapter"
bd close tackle-mep --reason "Codex adapter passing fixture tests + real subscription smoke turn"
git add docs/plans/2026-07-02-phase0-skeleton-notes.md
git commit -m "Record real-turn smoke evidence for the Phase 0 skeleton"
```

---

## Self-Review

**Spec coverage (skeleton scope):** TurnResult closed enum ✓ (types.ts, adapter status mapping); diff as artifact of record ✓ (Task 4, wired in Task 8); transcript on disk, never inlined ✓ (Task 8); authorship ✓ (Task 8, `model: null` = backend default preserving the shipped-default invariant); `billing_type` in the envelope with env-precedence semantics ✓ (Task 7); banned-key structural guard ✓ (Task 2); effort bands without model names ✓ (Tasks 2, 6, 9); Sandcastle borrowings (stdin-over-argv, usage normalization, defensive line parsing, resume verb) ✓ (Tasks 5, 6). Deliberately out of scope for this plan: spine, gates, dependency map, review loop, `refused`/`budget_exceeded` emission (reserved enum members only).

**Known judgment calls:** `--full-auto` (codex's own sandbox, auto-approval) is the default sandbox posture for v1 attended turns — verified live in Task 10. `summary` = last agent message (fine for single turns; the model-written phase summary comes with the spine). `sessionId` capture exists but `resumeSessionId` is only exercised at the command-builder level until the spine needs it.

**Type consistency:** `TurnRequest.timeoutMs` optional, CLI converts seconds→ms (Task 9 note); `TokenUsage` field names identical across stream.ts/types.ts/tests; fake-codex knobs go through `$HOME/.fake-codex.json`, keeping the adapter allowlist at exactly `["PATH", "HOME"]`.
