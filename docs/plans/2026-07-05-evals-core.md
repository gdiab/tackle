# Evals Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live-turn eval fixtures with model-free grading, a fingerprint replay cache, derived flaky-quarantine, a `tackle eval` command group, and a minimal CI workflow that re-grades from the cache at zero token cost.

**Architecture:** New first-class `src/evals/` module (manifest → fingerprint → materialize → grade → results → state → runner), wired into `src/cli.ts` as an `eval` command group following the `map` group's conventions. Live runs go through the existing `Adapter` seam; replay re-materializes the seed, applies the recorded diff, and re-runs the same graders.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Node >= 22 (CI runs 26), commander, vitest, pnpm. **Zero new npm dependencies.**

**Spec:** `docs/plans/2026-07-04-evals-core-design.md` (approved). Two deliberate deviations from the spec's letter, both flagged for review:
1. CI uses **pnpm** (`pnpm/action-setup` + `pnpm install --frozen-lockfile`), not the spec's `npm ci` — the repo has only `pnpm-lock.yaml` and declares `packageManager: pnpm@10.16.1`.
2. The `passing-test` fixture's `commandSucceeds` uses **`node --test`**, not the spec's `npx vitest run` — `npx vitest` would download vitest into every re-materialized temp workdir at grade time (network-dependent, slow, nondeterministic in CI). The spec's intent — "task must produce a test that passes" — is unchanged.

## Global Constraints

- Zero new npm dependencies (glob matching uses `matchesGlob` from `node:path`, Node >= 22.5; engines already say `>=22`).
- All module tests are model-free and spend zero tokens.
- ESM: relative imports carry the `.js` suffix (`import ... from "./manifest.js"`).
- `strict` + `noUncheckedIndexedAccess` are on — index reads need `undefined` guards.
- JSON files written by the harness: atomic tmp-file + rename, 2-space indent, trailing newline (match `src/map/store.ts`).
- Fixture layout: `evals/fixtures/<name>/manifest.json` + optional `evals/fixtures/<name>/seed/`. Results: `evals/results/<name>.json`, committed to git.
- `runs` newest-first, capped at 10. Fingerprint change resets `runs`.
- Fingerprint covers ONLY `prompt`, `effort`, `timeoutSeconds`, seed `(path, contentHash)` pairs, adapter name — NEVER `expectations`.
- Unknown expectation kind is a hard error everywhere (validation and grading), never a silent pass.
- Commit messages: short plain imperative (match `git log`), no AI/assistant mentions, no trailers.
- Run tests with `npx vitest run <file>`; typecheck with `npx tsc --noEmit`.

## File Structure

| File | Responsibility |
|---|---|
| `src/evals/manifest.ts` | `Expectation` union + `FixtureManifest`; `loadManifest` (validate, hard-error on unknown kind), `listFixtures` |
| `src/evals/fingerprint.ts` | `canonicalJson`, seed hashing, `computeFingerprint` |
| `src/evals/materialize.ts` | seed → fresh temp git repo; `applyRecordedDiff` for replay reconstruction |
| `src/evals/grade.ts` | `RecordedEnvelope`, `Grade` types, one grader per kind, exhaustive switch |
| `src/evals/results.ts` | result-file read/write, `appendRun` (window cap + fingerprint reset) |
| `src/evals/state.ts` | healthy / failing / flaky derivation |
| `src/evals/runner.ts` | orchestrates live run / replay re-grade / CI check |
| `src/cli.ts` | `registerEvalCommands` — `eval run`, `eval status`, `eval check` |
| `test/helpers/evals.ts` | fixture-builder + diff-producing fake adapter for tests |
| `test/eval-*.test.ts`, `test/cli-eval.test.ts` | per-module tests + CLI tests + e2e |
| `evals/fixtures/*` | the 4 real committed fixtures |
| `.github/workflows/ci.yml` | typecheck, test, build, `eval check` — no credentials, no tokens |

Existing code consumed (do not modify): `src/adapter/types.ts` (`Adapter`, `TurnRequest`, `TurnResult`, `TurnStatus`, `BillingType`, `Effort`, `Authorship`, `TokenUsage`), `src/adapter/diff.ts` (`git`, `captureWorkdirDiff`, `resolveHead`), `src/workflow/hash.ts` (`sha256`), `test/helpers/workflow.ts` (`tempWorkdir`, `fakeTurn`).

---

### Task 1: Manifest types, loader, fixture listing

**Files:**
- Create: `src/evals/manifest.ts`
- Create: `test/helpers/evals.ts`
- Test: `test/eval-manifest.test.ts`

**Interfaces:**
- Consumes: `TurnStatus`, `BillingType`, `Effort` from `src/adapter/types.ts`.
- Produces (later tasks rely on these exact names):
  - `type Expectation` — discriminated union on `kind`: `"status" | "billing" | "fileExists" | "fileContains" | "diffTouchesOnly" | "commandSucceeds"`.
  - `interface FixtureManifest { name: string; description: string; prompt: string; effort: Effort; timeoutSeconds: number; expectations: Expectation[] }`
  - `const FIXTURES_DIR = "evals/fixtures"`
  - `loadManifest(fixtureDir: string): Promise<FixtureManifest>` — throws descriptive `Error` on any invalid manifest.
  - `listFixtures(workdir: string): Promise<string[]>` — sorted names of subdirectories of `evals/fixtures` containing a `manifest.json`; `[]` if the dir doesn't exist.
  - Test helpers: `makeFixture(workdir, name, spec)` and `manifestFor(name, overrides)`.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/evals.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FixtureSpec {
  manifest: Record<string, unknown>;
  seed?: Record<string, string>;
}

/** Write evals/fixtures/<name>/ (manifest.json + optional seed files) under workdir. Returns the fixture dir. */
export async function makeFixture(workdir: string, name: string, spec: FixtureSpec): Promise<string> {
  const dir = join(workdir, "evals", "fixtures", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(spec.manifest, null, 2) + "\n");
  for (const [rel, content] of Object.entries(spec.seed ?? {})) {
    const path = join(dir, "seed", rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

/** A minimal valid manifest with overridable fields. */
export function manifestFor(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: "test fixture",
    prompt: "do the thing",
    effort: "low",
    timeoutSeconds: 60,
    expectations: [{ kind: "status", equals: "completed" }],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/eval-manifest.test.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFixtures, loadManifest } from "../src/evals/manifest.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("loadManifest", () => {
  it("loads and validates a full manifest", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "create-file", {
      manifest: manifestFor("create-file", {
        expectations: [
          { kind: "status", equals: "completed" },
          { kind: "billing", equals: "subscription" },
          { kind: "fileExists", path: "hello.txt" },
          { kind: "fileContains", path: "hello.txt", text: "hello", exact: true },
          { kind: "diffTouchesOnly", globs: ["hello.txt"] },
          { kind: "commandSucceeds", command: "true" },
        ],
      }),
    });
    const manifest = await loadManifest(dir);
    expect(manifest.name).toBe("create-file");
    expect(manifest.expectations).toHaveLength(6);
  });

  it("rejects an unknown expectation kind", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", {
      manifest: manifestFor("f", { expectations: [{ kind: "vibes", equals: "good" }] }),
    });
    await expect(loadManifest(dir)).rejects.toThrow(/unknown expectation kind "vibes"/);
  });

  it("rejects a status expectation outside the closed enum", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", {
      manifest: manifestFor("f", { expectations: [{ kind: "status", equals: "great" }] }),
    });
    await expect(loadManifest(dir)).rejects.toThrow(/equals must be one of/);
  });

  it("rejects a manifest whose name does not match its directory", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "actual", { manifest: manifestFor("other") });
    await expect(loadManifest(dir)).rejects.toThrow(/does not match directory name "actual"/);
  });

  it("rejects a missing manifest, invalid JSON, bad effort, and bad timeout", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "evals", "fixtures", "empty"), { recursive: true });
    await expect(loadManifest(join(workdir, "evals", "fixtures", "empty"))).rejects.toThrow(/missing manifest.json/);

    const bad1 = await makeFixture(workdir, "bad1", { manifest: manifestFor("bad1", { effort: "ultra" }) });
    await expect(loadManifest(bad1)).rejects.toThrow(/"effort" must be one of/);

    const bad2 = await makeFixture(workdir, "bad2", { manifest: manifestFor("bad2", { timeoutSeconds: 0 }) });
    await expect(loadManifest(bad2)).rejects.toThrow(/"timeoutSeconds" must be a positive number/);

    const bad3 = await makeFixture(workdir, "bad3", { manifest: manifestFor("bad3", { expectations: [] }) });
    await expect(loadManifest(bad3)).rejects.toThrow(/"expectations" must be a non-empty array/);
  });
});

describe("listFixtures", () => {
  it("returns sorted fixture names, skipping non-fixture entries", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "zeta", { manifest: manifestFor("zeta") });
    await makeFixture(workdir, "alpha", { manifest: manifestFor("alpha") });
    await mkdir(join(workdir, "evals", "fixtures", "no-manifest"), { recursive: true });
    expect(await listFixtures(workdir)).toEqual(["alpha", "zeta"]);
  });

  it("returns [] when evals/fixtures does not exist", async () => {
    expect(await listFixtures(await tempWorkdir())).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/eval-manifest.test.ts`
Expected: FAIL — cannot resolve `../src/evals/manifest.js`.

- [ ] **Step 4: Implement `src/evals/manifest.ts`**

```ts
import { access, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BillingType, Effort, TurnStatus } from "../adapter/types.js";

export const FIXTURES_DIR = "evals/fixtures";

export type Expectation =
  | { kind: "status"; equals: TurnStatus }
  | { kind: "billing"; equals: BillingType }
  | { kind: "fileExists"; path: string }
  | { kind: "fileContains"; path: string; text: string; exact?: boolean }
  | { kind: "diffTouchesOnly"; globs: string[] }
  | { kind: "commandSucceeds"; command: string };

export interface FixtureManifest {
  name: string;
  description: string;
  prompt: string;
  effort: Effort;
  timeoutSeconds: number;
  expectations: Expectation[];
}

const STATUSES: readonly TurnStatus[] = ["completed", "refused", "timeout", "tool_error", "budget_exceeded"];
const BILLINGS: readonly BillingType[] = ["subscription", "metered", "unknown"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

function fail(fixture: string, message: string): never {
  throw new Error(`${FIXTURES_DIR}/${fixture}/manifest.json: ${message}`);
}

export async function loadManifest(fixtureDir: string): Promise<FixtureManifest> {
  const name = basename(fixtureDir);
  let raw: string;
  try {
    raw = await readFile(join(fixtureDir, "manifest.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") fail(name, "missing manifest.json");
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(name, "manifest.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(name, "manifest must be a JSON object");
  }
  const m = parsed as Record<string, unknown>;
  if (m.name !== name) {
    fail(name, `manifest name ${JSON.stringify(m.name)} does not match directory name "${name}"`);
  }
  for (const field of ["description", "prompt"] as const) {
    const value = m[field];
    if (typeof value !== "string" || value.length === 0) fail(name, `"${field}" must be a non-empty string`);
  }
  if (!EFFORTS.includes(m.effort as Effort)) fail(name, `"effort" must be one of ${EFFORTS.join(", ")}`);
  if (typeof m.timeoutSeconds !== "number" || !Number.isFinite(m.timeoutSeconds) || m.timeoutSeconds <= 0) {
    fail(name, `"timeoutSeconds" must be a positive number`);
  }
  if (!Array.isArray(m.expectations) || m.expectations.length === 0) {
    fail(name, `"expectations" must be a non-empty array`);
  }
  return {
    name,
    description: m.description as string,
    prompt: m.prompt as string,
    effort: m.effort as Effort,
    timeoutSeconds: m.timeoutSeconds,
    expectations: m.expectations.map((e, i) => validateExpectation(name, e, i)),
  };
}

function validateExpectation(fixture: string, value: unknown, index: number): Expectation {
  const at = `expectations[${index}]`;
  if (typeof value !== "object" || value === null) fail(fixture, `${at} must be an object`);
  const e = value as Record<string, unknown>;
  const str = (field: string): string => {
    const v = e[field];
    if (typeof v !== "string" || v.length === 0) fail(fixture, `${at}.${field} must be a non-empty string`);
    return v;
  };
  switch (e.kind) {
    case "status":
      if (!STATUSES.includes(e.equals as TurnStatus)) fail(fixture, `${at}.equals must be one of ${STATUSES.join(", ")}`);
      return { kind: "status", equals: e.equals as TurnStatus };
    case "billing":
      if (!BILLINGS.includes(e.equals as BillingType)) fail(fixture, `${at}.equals must be one of ${BILLINGS.join(", ")}`);
      return { kind: "billing", equals: e.equals as BillingType };
    case "fileExists":
      return { kind: "fileExists", path: str("path") };
    case "fileContains": {
      if (e.exact !== undefined && typeof e.exact !== "boolean") fail(fixture, `${at}.exact must be a boolean`);
      const base = { kind: "fileContains" as const, path: str("path"), text: str("text") };
      return e.exact === undefined ? base : { ...base, exact: e.exact };
    }
    case "diffTouchesOnly":
      if (!Array.isArray(e.globs) || e.globs.length === 0 || !e.globs.every((g) => typeof g === "string" && g.length > 0)) {
        fail(fixture, `${at}.globs must be a non-empty array of glob strings`);
      }
      return { kind: "diffTouchesOnly", globs: e.globs as string[] };
    case "commandSucceeds":
      return { kind: "commandSucceeds", command: str("command") };
    default:
      fail(fixture, `unknown expectation kind ${JSON.stringify(e.kind)}`);
  }
}

export async function listFixtures(workdir: string): Promise<string[]> {
  const dir = join(workdir, FIXTURES_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(dir, entry.name, "manifest.json"));
      names.push(entry.name);
    } catch {
      // a directory without manifest.json is not a fixture
    }
  }
  return names.sort();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/eval-manifest.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/evals/manifest.ts test/helpers/evals.ts test/eval-manifest.test.ts
git commit -m "Add eval fixture manifest loading and validation"
```

---

### Task 2: Fingerprint — canonical JSON + seed hashing

**Files:**
- Create: `src/evals/fingerprint.ts`
- Test: `test/eval-fingerprint.test.ts`

**Interfaces:**
- Consumes: `FixtureManifest` (Task 1), `sha256` from `src/workflow/hash.ts`.
- Produces:
  - `canonicalJson(value: unknown): string` — deterministic JSON with recursively sorted object keys.
  - `computeFingerprint(opts: { fixtureDir: string; manifest: FixtureManifest; adapterName: string }): Promise<string>` — returns `"sha256:<hex>"`. Covers ONLY `prompt`, `effort`, `timeoutSeconds`, sorted seed `(path, contentHash)` pairs, and `adapterName`. Changing `expectations` (or `description`) MUST NOT change the fingerprint.

- [ ] **Step 1: Write the failing tests**

Create `test/eval-fingerprint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, computeFingerprint } from "../src/evals/fingerprint.js";
import { loadManifest } from "../src/evals/manifest.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

async function fingerprintOf(name: string, overrides: Record<string, unknown>, seed?: Record<string, string>) {
  const workdir = await tempWorkdir();
  const dir = await makeFixture(workdir, name, { manifest: manifestFor(name, overrides), ...(seed === undefined ? {} : { seed }) });
  return computeFingerprint({ fixtureDir: dir, manifest: await loadManifest(dir), adapterName: "codex" });
}

describe("computeFingerprint", () => {
  it("is stable across expectation and description changes", async () => {
    const a = await fingerprintOf("f", { description: "one" });
    const b = await fingerprintOf("f", {
      description: "two",
      expectations: [{ kind: "fileExists", path: "x" }],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when prompt, effort, timeout, adapter, or seed content changes", async () => {
    const base = await fingerprintOf("f", {}, { "a.txt": "1" });
    expect(await fingerprintOf("f", { prompt: "different" }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", { effort: "high" }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", { timeoutSeconds: 61 }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", {}, { "a.txt": "2" })).not.toBe(base);
    expect(await fingerprintOf("f", {}, { "b.txt": "1" })).not.toBe(base);
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", { manifest: manifestFor("f"), seed: { "a.txt": "1" } });
    const otherAdapter = await computeFingerprint({ fixtureDir: dir, manifest: await loadManifest(dir), adapterName: "claude" });
    expect(otherAdapter).not.toBe(base);
  });

  it("handles a seedless fixture and nested seed paths", async () => {
    const seedless = await fingerprintOf("f", {});
    expect(seedless).toMatch(/^sha256:/);
    const nested = await fingerprintOf("f", {}, { "src/deep/a.txt": "1" });
    expect(nested).not.toBe(seedless);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval-fingerprint.test.ts`
Expected: FAIL — cannot resolve `../src/evals/fingerprint.js`.

- [ ] **Step 3: Implement `src/evals/fingerprint.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "../workflow/hash.js";
import type { FixtureManifest } from "./manifest.js";

/** Deterministic JSON: recursively sorted object keys, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sorted (relative path, content sha256) pairs for every file under seed/; [] when there is no seed. */
async function seedEntries(fixtureDir: string): Promise<Array<[string, string]>> {
  const seedDir = join(fixtureDir, "seed");
  let dirents;
  try {
    dirents = await readdir(seedDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: Array<[string, string]> = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const abs = join(dirent.parentPath, dirent.name);
    entries.push([relative(seedDir, abs), sha256(await readFile(abs, "utf8"))]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries;
}

/**
 * Fingerprint over run-affecting inputs ONLY: prompt, effort, timeoutSeconds,
 * seed content, adapter name. Expectations are deliberately excluded so
 * grading changes never invalidate cached runs (see the design doc).
 */
export async function computeFingerprint(opts: {
  fixtureDir: string;
  manifest: FixtureManifest;
  adapterName: string;
}): Promise<string> {
  const input = canonicalJson({
    adapter: opts.adapterName,
    prompt: opts.manifest.prompt,
    effort: opts.manifest.effort,
    timeoutSeconds: opts.manifest.timeoutSeconds,
    seed: await seedEntries(opts.fixtureDir),
  });
  return `sha256:${sha256(input)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval-fingerprint.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/evals/fingerprint.ts test/eval-fingerprint.test.ts
git commit -m "Add eval fingerprint over run-affecting fixture inputs"
```

---

### Task 3: Materializer — seed to temp git repo, replay reconstruction

**Files:**
- Create: `src/evals/materialize.ts`
- Test: `test/eval-materialize.test.ts`

**Interfaces:**
- Consumes: `git` from `src/adapter/diff.ts` (`git(workdir, args): Promise<string>` runs `git -C workdir ...`).
- Produces:
  - `materializeWorkdir(fixtureDir: string): Promise<string>` — fresh temp dir with `seed/` copied in (if present), `git init`, identity configured, everything committed (`--allow-empty` covers seedless fixtures). Returns the workdir path. Caller is responsible for removing it.
  - `applyRecordedDiff(workdir: string, diff: string): Promise<void>` — applies a recorded `workdirDiff` (as produced by `captureWorkdirDiff`: tracked diffs + `--no-index` new-file diffs concatenated) via `git apply`; no-op on the empty string; throws on apply failure.

- [ ] **Step 1: Write the failing tests**

Create `test/eval-materialize.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, git, resolveHead } from "../src/adapter/diff.js";
import { applyRecordedDiff, materializeWorkdir } from "../src/evals/materialize.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("materializeWorkdir", () => {
  it("copies the seed into a fresh committed git repo", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", {
      manifest: manifestFor("f"),
      seed: { "greeting.txt": "hello world\n", "src/deep.txt": "deep\n" },
    });
    const workdir = await materializeWorkdir(dir);
    expect(await readFile(join(workdir, "greeting.txt"), "utf8")).toBe("hello world\n");
    expect(await readFile(join(workdir, "src", "deep.txt"), "utf8")).toBe("deep\n");
    expect((await git(workdir, ["status", "--porcelain"])).trim()).toBe("");
    await expect(resolveHead(workdir)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("materializes a seedless fixture as an empty repo with one commit", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f") });
    const workdir = await materializeWorkdir(dir);
    await expect(resolveHead(workdir)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("applyRecordedDiff", () => {
  it("reconstructs new and modified files from a recorded workdirDiff", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f"), seed: { "greeting.txt": "hello world\n" } });

    // First materialization plays the "live turn": modify a seeded file, add a new one.
    const live = await materializeWorkdir(dir);
    const head = await resolveHead(live);
    await writeFile(join(live, "greeting.txt"), "hello tackle\n");
    await writeFile(join(live, "hello.txt"), "hello\n");
    const diff = await captureWorkdirDiff(live, head);
    expect(diff).not.toBe("");

    // Second materialization replays it.
    const replay = await materializeWorkdir(dir);
    await applyRecordedDiff(replay, diff);
    expect(await readFile(join(replay, "greeting.txt"), "utf8")).toBe("hello tackle\n");
    expect(await readFile(join(replay, "hello.txt"), "utf8")).toBe("hello\n");
  });

  it("is a no-op on an empty diff and throws on a non-applying diff", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f") });
    const workdir = await materializeWorkdir(dir);
    await expect(applyRecordedDiff(workdir, "")).resolves.toBeUndefined();
    await expect(applyRecordedDiff(workdir, "not a diff\n")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval-materialize.test.ts`
Expected: FAIL — cannot resolve `../src/evals/materialize.js`.

- [ ] **Step 3: Implement `src/evals/materialize.ts`**

```ts
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../adapter/diff.js";

/**
 * Seed -> fresh temp git repo: copy seed/ (when present), init, commit.
 * The turn (or replay) runs with this as cwd. Caller removes the dir.
 */
export async function materializeWorkdir(fixtureDir: string): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "tackle-eval-"));
  const seedDir = join(fixtureDir, "seed");
  const hasSeed = await stat(seedDir).then((s) => s.isDirectory()).catch(() => false);
  if (hasSeed) await cp(seedDir, workdir, { recursive: true });
  await git(workdir, ["init", "-q"]);
  await git(workdir, ["config", "user.name", "tackle-eval"]);
  await git(workdir, ["config", "user.email", "tackle-eval@local"]);
  await git(workdir, ["add", "-A"]);
  await git(workdir, ["commit", "-q", "--allow-empty", "-m", "seed"]);
  return workdir;
}

/** Reconstruct a recorded run's tree: apply its workdirDiff onto a fresh materialization. */
export async function applyRecordedDiff(workdir: string, diff: string): Promise<void> {
  if (diff.length === 0) return;
  const patchDir = await mkdtemp(join(tmpdir(), "tackle-eval-patch-"));
  const patchFile = join(patchDir, "run.patch");
  try {
    await writeFile(patchFile, diff);
    await git(workdir, ["apply", "--whitespace=nowarn", patchFile]);
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval-materialize.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/evals/materialize.ts test/eval-materialize.test.ts
git commit -m "Add eval workdir materializer and recorded-diff replay"
```

---

### Task 4: Graders — the closed expectation union, executed

**Files:**
- Create: `src/evals/grade.ts`
- Test: `test/eval-grade.test.ts`

**Interfaces:**
- Consumes: `Expectation`, `FixtureManifest` (Task 1); `Authorship`, `BillingType`, `TokenUsage`, `TurnStatus` from `src/adapter/types.ts`.
- Produces:
  - `interface RecordedEnvelope { status: TurnStatus; summary: string; authorship: Authorship; usage: { tokens: TokenUsage; billingType: BillingType } }` — the recorded subset of a `TurnResult` (everything except `workdirDiff`, `transcriptRef`, `sessionId`, which are stored/derived elsewhere).
  - `interface ExpectationGrade { expectation: Expectation; pass: boolean; message: string }` — `message` is `""` on pass, a one-line failure reason otherwise.
  - `interface Grade { pass: boolean; expectations: ExpectationGrade[] }` — `pass` is true iff every expectation passes.
  - `gradeFixture(opts: { manifest: FixtureManifest; envelope: RecordedEnvelope; workdir: string; workdirDiff: string }): Promise<Grade>` — `workdir` is a materialized tree that already contains the turn's changes (live: the turn's cwd; replay: seed + applied diff).
  - `diffPaths(diff: string): string[]` — sorted unique repo-relative paths a unified diff touches (exported for tests).

- [ ] **Step 1: Write the failing tests**

Create `test/eval-grade.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffPaths, gradeFixture } from "../src/evals/grade.js";
import type { RecordedEnvelope } from "../src/evals/grade.js";
import type { Expectation, FixtureManifest } from "../src/evals/manifest.js";
import { tempWorkdir } from "./helpers/workflow.js";

function envelope(overrides: Partial<RecordedEnvelope> = {}): RecordedEnvelope {
  return {
    status: "completed",
    summary: "did it",
    authorship: { adapter: "codex", model: null, effort: "low" },
    usage: {
      tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
      billingType: "subscription",
    },
    ...overrides,
  };
}

function manifestWith(expectations: Expectation[]): FixtureManifest {
  return { name: "f", description: "d", prompt: "p", effort: "low", timeoutSeconds: 60, expectations };
}

async function gradeOne(expectation: Expectation, opts: { envelope?: RecordedEnvelope; workdir?: string; workdirDiff?: string } = {}) {
  const workdir = opts.workdir ?? (await tempWorkdir());
  const grade = await gradeFixture({
    manifest: manifestWith([expectation]),
    envelope: opts.envelope ?? envelope(),
    workdir,
    workdirDiff: opts.workdirDiff ?? "",
  });
  const first = grade.expectations[0];
  if (first === undefined) throw new Error("no expectation graded");
  return { grade, first };
}

describe("envelope graders", () => {
  it("status passes on match and fails with a message on mismatch", async () => {
    expect((await gradeOne({ kind: "status", equals: "completed" })).grade.pass).toBe(true);
    const { grade, first } = await gradeOne({ kind: "status", equals: "completed" }, { envelope: envelope({ status: "timeout" }) });
    expect(grade.pass).toBe(false);
    expect(first.message).toContain('"timeout"');
  });

  it("billing compares the envelope billingType", async () => {
    expect((await gradeOne({ kind: "billing", equals: "subscription" })).grade.pass).toBe(true);
    const { grade } = await gradeOne(
      { kind: "billing", equals: "subscription" },
      { envelope: envelope({ usage: { ...envelope().usage, billingType: "metered" } }) },
    );
    expect(grade.pass).toBe(false);
  });
});

describe("workdir graders", () => {
  it("fileExists and fileContains (substring and exact)", async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, "hello.txt"), "well hello there\n");
    expect((await gradeOne({ kind: "fileExists", path: "hello.txt" }, { workdir })).grade.pass).toBe(true);
    expect((await gradeOne({ kind: "fileExists", path: "nope.txt" }, { workdir })).grade.pass).toBe(false);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "hello" }, { workdir })).grade.pass).toBe(true);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "goodbye" }, { workdir })).grade.pass).toBe(false);
    expect((await gradeOne({ kind: "fileContains", path: "hello.txt", text: "hello", exact: true }, { workdir })).grade.pass).toBe(false);
    expect(
      (await gradeOne({ kind: "fileContains", path: "hello.txt", text: "well hello there\n", exact: true }, { workdir })).grade.pass,
    ).toBe(true);
    expect((await gradeOne({ kind: "fileContains", path: "nope.txt", text: "x" }, { workdir })).grade.pass).toBe(false);
  });

  it("commandSucceeds runs in the workdir and grades on exit code", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "marker-dir"));
    expect(
      (await gradeOne({ kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('marker-dir')\"" }, { workdir })).grade.pass,
    ).toBe(true);
    const { grade, first } = await gradeOne({ kind: "commandSucceeds", command: "node -e \"process.exit(3)\"" }, { workdir });
    expect(grade.pass).toBe(false);
    expect(first.message.length).toBeGreaterThan(0);
  });
});

describe("diffTouchesOnly", () => {
  const diff = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 000..111 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/rogue.txt b/rogue.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/rogue.txt",
    "@@ -0,0 +1 @@",
    "+surprise",
    "",
  ].join("\n");

  it("extracts touched paths, ignoring /dev/null", () => {
    expect(diffPaths(diff)).toEqual(["rogue.txt", "src/keep.ts"]);
  });

  it("passes when all touched paths match a glob, fails and names the stray otherwise", async () => {
    expect((await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**", "rogue.txt"] }, { workdirDiff: diff })).grade.pass).toBe(true);
    const { grade, first } = await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**"] }, { workdirDiff: diff });
    expect(grade.pass).toBe(false);
    expect(first.message).toContain("rogue.txt");
  });

  it("passes on an empty diff", async () => {
    expect((await gradeOne({ kind: "diffTouchesOnly", globs: ["src/**"] }, { workdirDiff: "" })).grade.pass).toBe(true);
  });
});

describe("exhaustiveness", () => {
  it("throws on an unknown kind smuggled past validation", async () => {
    const rogue = { kind: "vibes" } as unknown as Expectation;
    await expect(
      gradeFixture({ manifest: manifestWith([rogue]), envelope: envelope(), workdir: await tempWorkdir(), workdirDiff: "" }),
    ).rejects.toThrow(/unknown expectation kind/);
  });

  it("aggregate pass requires every expectation to pass", async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, "hello.txt"), "hello\n");
    const grade = await gradeFixture({
      manifest: manifestWith([
        { kind: "fileExists", path: "hello.txt" },
        { kind: "status", equals: "refused" },
      ]),
      envelope: envelope(),
      workdir,
      workdirDiff: "",
    });
    expect(grade.pass).toBe(false);
    expect(grade.expectations.map((e) => e.pass)).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval-grade.test.ts`
Expected: FAIL — cannot resolve `../src/evals/grade.js`.

- [ ] **Step 3: Implement `src/evals/grade.ts`**

```ts
import { exec } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import type { Authorship, BillingType, TokenUsage, TurnStatus } from "../adapter/types.js";
import type { Expectation, FixtureManifest } from "./manifest.js";

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 300_000;

/** The recorded subset of a TurnResult that grading and the result file need. */
export interface RecordedEnvelope {
  status: TurnStatus;
  summary: string;
  authorship: Authorship;
  usage: { tokens: TokenUsage; billingType: BillingType };
}

export interface ExpectationGrade {
  expectation: Expectation;
  pass: boolean;
  /** "" when passing; a one-line failure reason otherwise. */
  message: string;
}

export interface Grade {
  pass: boolean;
  expectations: ExpectationGrade[];
}

/** Sorted unique repo-relative paths a unified diff touches (a/ and b/ sides, /dev/null excluded). */
export function diffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return [...paths].sort();
}

interface GradeContext {
  envelope: RecordedEnvelope;
  workdir: string;
  workdirDiff: string;
}

async function gradeOne(expectation: Expectation, ctx: GradeContext): Promise<ExpectationGrade> {
  switch (expectation.kind) {
    case "status": {
      const pass = ctx.envelope.status === expectation.equals;
      return { expectation, pass, message: pass ? "" : `status was "${ctx.envelope.status}", expected "${expectation.equals}"` };
    }
    case "billing": {
      const actual = ctx.envelope.usage.billingType;
      const pass = actual === expectation.equals;
      return { expectation, pass, message: pass ? "" : `billing was "${actual}", expected "${expectation.equals}"` };
    }
    case "fileExists": {
      const pass = await stat(join(ctx.workdir, expectation.path)).then((s) => s.isFile()).catch(() => false);
      return { expectation, pass, message: pass ? "" : `${expectation.path} does not exist` };
    }
    case "fileContains": {
      let content: string;
      try {
        content = await readFile(join(ctx.workdir, expectation.path), "utf8");
      } catch {
        return { expectation, pass: false, message: `${expectation.path} does not exist` };
      }
      if (expectation.exact === true) {
        const pass = content === expectation.text;
        return { expectation, pass, message: pass ? "" : `${expectation.path} content does not exactly equal the expected text` };
      }
      const pass = content.includes(expectation.text);
      return { expectation, pass, message: pass ? "" : `${expectation.path} does not contain ${JSON.stringify(expectation.text)}` };
    }
    case "diffTouchesOnly": {
      const strays = diffPaths(ctx.workdirDiff).filter((p) => !expectation.globs.some((glob) => matchesGlob(p, glob)));
      const pass = strays.length === 0;
      return { expectation, pass, message: pass ? "" : `diff touches ${strays.join(", ")} outside ${expectation.globs.join(", ")}` };
    }
    case "commandSucceeds": {
      try {
        await execAsync(expectation.command, { cwd: ctx.workdir, timeout: COMMAND_TIMEOUT_MS });
        return { expectation, pass: true, message: "" };
      } catch (err) {
        const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
        return { expectation, pass: false, message: `command failed: ${detail ?? "unknown error"}` };
      }
    }
    default: {
      const impossible: never = expectation;
      throw new Error(`unknown expectation kind: ${JSON.stringify(impossible)}`);
    }
  }
}

/** Grade every expectation; a fixture passes when all of them do. Never silently skips. */
export async function gradeFixture(opts: {
  manifest: FixtureManifest;
  envelope: RecordedEnvelope;
  workdir: string;
  workdirDiff: string;
}): Promise<Grade> {
  const expectations: ExpectationGrade[] = [];
  for (const expectation of opts.manifest.expectations) {
    expectations.push(await gradeOne(expectation, opts));
  }
  return { pass: expectations.every((g) => g.pass), expectations };
}
```

Note: `matchesGlob` (Node >= 22.5) may print a one-time ExperimentalWarning to stderr; that is acceptable and does not affect grading.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval-grade.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/evals/grade.ts test/eval-grade.test.ts
git commit -m "Add eval graders for the closed expectation union"
```

---

### Task 5: Results store — read/write, window cap, fingerprint reset

**Files:**
- Create: `src/evals/results.ts`
- Test: `test/eval-results.test.ts`

**Interfaces:**
- Consumes: `Grade`, `RecordedEnvelope` (Task 4).
- Produces:
  - `const RESULTS_DIR = "evals/results"`, `const RUN_WINDOW = 10`
  - `interface RecordedRun { at: string; adapterVersion: string; envelope: RecordedEnvelope; workdirDiff: string; grade: Grade }` (`at` is ISO-8601)
  - `interface ResultFile { fixture: string; fingerprint: string; runs: RecordedRun[] }` (runs newest-first)
  - `readResult(workdir: string, fixture: string): Promise<ResultFile | null>` — `null` on ENOENT; throws with guidance on invalid JSON/shape (mirror `src/map/store.ts` messages).
  - `writeResult(workdir: string, result: ResultFile): Promise<void>` — atomic tmp+rename into `evals/results/<fixture>.json`.
  - `appendRun(existing: ResultFile | null, fixture: string, fingerprint: string, run: RecordedRun): ResultFile` — prepend; slice to `RUN_WINDOW`; a different fingerprint (or `null` existing) starts a fresh single-run history.

- [ ] **Step 1: Write the failing tests**

Create `test/eval-results.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedRun } from "../src/evals/results.js";
import { appendRun, readResult, RUN_WINDOW, writeResult } from "../src/evals/results.js";
import { tempWorkdir } from "./helpers/workflow.js";

function run(at: string, pass = true): RecordedRun {
  return {
    at,
    adapterVersion: "codex-cli 0.0.0",
    envelope: {
      status: "completed",
      summary: "s",
      authorship: { adapter: "codex", model: null, effort: "low" },
      usage: {
        tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
        billingType: "subscription",
      },
    },
    workdirDiff: "",
    grade: { pass, expectations: [] },
  };
}

describe("readResult / writeResult", () => {
  it("returns null when the result file does not exist", async () => {
    expect(await readResult(await tempWorkdir(), "create-file")).toBeNull();
  });

  it("round-trips a result file with a trailing newline", async () => {
    const workdir = await tempWorkdir();
    const result = { fixture: "create-file", fingerprint: "sha256:abc", runs: [run("2026-07-05T00:00:00.000Z")] };
    await writeResult(workdir, result);
    expect(await readResult(workdir, "create-file")).toEqual(result);
    const raw = await readFile(join(workdir, "evals", "results", "create-file.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("throws with guidance on invalid JSON and on a wrong shape", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "evals", "results"), { recursive: true });
    await writeFile(join(workdir, "evals", "results", "broken.json"), "{nope");
    await expect(readResult(workdir, "broken")).rejects.toThrow(/not valid JSON/);
    await writeFile(join(workdir, "evals", "results", "odd.json"), JSON.stringify({ fixture: "odd" }) + "\n");
    await expect(readResult(workdir, "odd")).rejects.toThrow(/missing/);
  });
});

describe("appendRun", () => {
  it("starts fresh history when there is no existing result", () => {
    const result = appendRun(null, "f", "sha256:a", run("t1"));
    expect(result).toEqual({ fixture: "f", fingerprint: "sha256:a", runs: [run("t1")] });
  });

  it("prepends newest-first and caps the window at RUN_WINDOW", () => {
    let result = appendRun(null, "f", "sha256:a", run("t0"));
    for (let i = 1; i <= RUN_WINDOW + 2; i++) result = appendRun(result, "f", "sha256:a", run(`t${i}`));
    expect(result.runs).toHaveLength(RUN_WINDOW);
    expect(result.runs[0]?.at).toBe(`t${RUN_WINDOW + 2}`);
    expect(result.runs[RUN_WINDOW - 1]?.at).toBe("t3");
  });

  it("resets history on a fingerprint change", () => {
    const existing = appendRun(null, "f", "sha256:a", run("t1", false));
    const reset = appendRun(existing, "f", "sha256:b", run("t2"));
    expect(reset).toEqual({ fixture: "f", fingerprint: "sha256:b", runs: [run("t2")] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval-results.test.ts`
Expected: FAIL — cannot resolve `../src/evals/results.js`.

- [ ] **Step 3: Implement `src/evals/results.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Grade, RecordedEnvelope } from "./grade.js";

export const RESULTS_DIR = "evals/results";
/** Trailing window for state derivation; pass-rates from different behaviors must never mix. */
export const RUN_WINDOW = 10;

export interface RecordedRun {
  at: string; // ISO-8601
  adapterVersion: string;
  envelope: RecordedEnvelope;
  workdirDiff: string;
  grade: Grade;
}

export interface ResultFile {
  fixture: string;
  fingerprint: string;
  runs: RecordedRun[]; // newest-first, capped at RUN_WINDOW
}

export async function readResult(workdir: string, fixture: string): Promise<ResultFile | null> {
  const file = `${RESULTS_DIR}/${fixture}.json`;
  let raw: string;
  try {
    raw = await readFile(join(workdir, file), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; delete it and re-run \`tackle eval run ${fixture}\``);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object; delete it and re-run \`tackle eval run ${fixture}\``);
  }
  const result = parsed as ResultFile;
  if (typeof result.fixture !== "string" || typeof result.fingerprint !== "string" || !Array.isArray(result.runs)) {
    throw new Error(`${file} is missing its fixture/fingerprint/runs structure; delete it and re-run \`tackle eval run ${fixture}\``);
  }
  return result;
}

export async function writeResult(workdir: string, result: ResultFile): Promise<void> {
  await mkdir(join(workdir, RESULTS_DIR), { recursive: true });
  const target = join(workdir, RESULTS_DIR, `${result.fixture}.json`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2) + "\n");
  await rename(tmp, target);
}

/** Prepend a run. A fingerprint change (or no prior file) starts a fresh history. */
export function appendRun(existing: ResultFile | null, fixture: string, fingerprint: string, run: RecordedRun): ResultFile {
  if (existing === null || existing.fingerprint !== fingerprint) {
    return { fixture, fingerprint, runs: [run] };
  }
  return { fixture, fingerprint, runs: [run, ...existing.runs].slice(0, RUN_WINDOW) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval-results.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/evals/results.ts test/eval-results.test.ts
git commit -m "Add eval result store with run window and fingerprint reset"
```

---

### Task 6: State derivation — healthy / failing / flaky

**Files:**
- Create: `src/evals/state.ts`
- Test: `test/eval-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FixtureState = "healthy" | "failing" | "flaky"`
  - `deriveState(passes: boolean[]): FixtureState` — all true → `healthy`; all false → `failing` (a single failing run is `failing`); mixed → `flaky`; empty array throws.

- [ ] **Step 1: Write the failing tests**

Create `test/eval-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveState } from "../src/evals/state.js";

describe("deriveState", () => {
  it("is healthy when every run in the window passes", () => {
    expect(deriveState([true, true, true])).toBe("healthy");
    expect(deriveState([true])).toBe("healthy");
  });

  it("is failing when every run fails, including a single-run history", () => {
    expect(deriveState([false, false])).toBe("failing");
    expect(deriveState([false])).toBe("failing");
  });

  it("is flaky when the window mixes passes and failures", () => {
    expect(deriveState([true, false, true])).toBe("flaky");
  });

  it("throws on an empty window", () => {
    expect(() => deriveState([])).toThrow(/at least one graded run/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval-state.test.ts`
Expected: FAIL — cannot resolve `../src/evals/state.js`.

- [ ] **Step 3: Implement `src/evals/state.ts`**

```ts
/**
 * Quarantine state derived from the graded trailing window — never curated.
 * healthy: every run passes. failing: every run fails (real signal; human
 * decision). flaky: both present — visible, tracked, never blocking.
 */
export type FixtureState = "healthy" | "failing" | "flaky";

export function deriveState(passes: boolean[]): FixtureState {
  if (passes.length === 0) throw new Error("deriveState requires at least one graded run");
  if (passes.every((p) => p)) return "healthy";
  if (passes.every((p) => !p)) return "failing";
  return "flaky";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval-state.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/evals/state.ts test/eval-state.test.ts
git commit -m "Add flaky-quarantine state derivation"
```

---

### Task 7: Runner — live run, replay re-grade, CI check

**Files:**
- Create: `src/evals/runner.ts`
- Modify: `test/helpers/evals.ts` (add `evalAdapter`)
- Test: `test/eval-runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6 plus `Adapter` from `src/adapter/types.ts` and `fakeTurn` from `test/helpers/workflow.ts`.
- Produces:
  - `interface RunReport { fixture: string; mode: "live" | "replay"; state: FixtureState; latestGrade: Grade }`
  - `runFixture(opts: { workdir: string; fixture: string; adapter: Adapter; force?: boolean; adapterVersion?: (adapter: Adapter) => Promise<string>; now?: () => Date }): Promise<RunReport>`
  - `interface CheckReport { fixture: string; stale: boolean; state: FixtureState | null }` (`state` is `null` iff `stale`)
  - `checkFixture(opts: { workdir: string; fixture: string; adapterName: string }): Promise<CheckReport>` — replay-only, read-only, zero tokens.
  - `defaultAdapterVersion(adapter: Adapter): Promise<string>` — `<adapter binary> --version` stdout, `"unknown"` on any failure.
  - Test helper `evalAdapter(files, overrides?)` — fake `Adapter` named `"codex"` that writes `files` into the turn workdir and returns a `TurnResult` carrying the REAL `captureWorkdirDiff` output; exposes `calls`.

**Semantics (from the design doc):**
- `runFixture`: fingerprint hit + runs exist + not `--force` → replay: re-grade EVERY run in the window against current expectations (re-materialize seed, apply recorded diff, grade), persist the updated grades, spend zero tokens. Miss (or `--force`) → live turn in a fresh materialized workdir; grade; `appendRun`; persist. `appendRun` handles history reset on fingerprint change.
- `checkFixture`: no result file, fingerprint mismatch, or empty runs → `stale: true` (never a silent skip). Otherwise re-grade every run in the window (fresh grades, not stored ones) and derive state. Never writes.

- [ ] **Step 1: Add `evalAdapter` to `test/helpers/evals.ts`**

Append to the file (new imports go at the top: `import { join, dirname } from "node:path"` is already there via `dirname, join`; add the rest):

```ts
import { captureWorkdirDiff, resolveHead } from "../../src/adapter/diff.js";
import type { Adapter, TurnRequest, TurnResult } from "../../src/adapter/types.js";
import { fakeTurn } from "./workflow.js";

/**
 * Fake adapter that behaves like a real turn: writes files into the turn's
 * workdir and returns a TurnResult carrying the real captured diff.
 */
export function evalAdapter(
  files: Record<string, string>,
  overrides: Partial<TurnResult> = {},
): Adapter & { readonly calls: number } {
  const state = { calls: 0 };
  return {
    name: "codex",
    get calls() {
      return state.calls;
    },
    run: async (req: TurnRequest): Promise<TurnResult> => {
      state.calls += 1;
      const base = await resolveHead(req.workdir);
      for (const [rel, content] of Object.entries(files)) {
        const path = join(req.workdir, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      const workdirDiff = await captureWorkdirDiff(req.workdir, base);
      return {
        ...fakeTurn({ authorship: { adapter: "codex", model: null, effort: req.effort } }),
        workdirDiff,
        ...overrides,
      };
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/eval-runner.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readResult } from "../src/evals/results.js";
import { checkFixture, runFixture } from "../src/evals/runner.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

const version = async () => "codex-cli 0.0.0-test";

const helloManifest = (overrides: Record<string, unknown> = {}) =>
  manifestFor("hello", {
    prompt: "write hello.txt",
    expectations: [
      { kind: "status", equals: "completed" },
      { kind: "billing", equals: "subscription" },
      { kind: "fileContains", path: "hello.txt", text: "hello" },
      { kind: "diffTouchesOnly", globs: ["hello.txt"] },
    ],
    ...overrides,
  });

describe("runFixture", () => {
  it("live-runs on a fingerprint miss, grades, and persists the run", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    const report = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(report).toMatchObject({ fixture: "hello", mode: "live", state: "healthy" });
    expect(report.latestGrade.pass).toBe(true);
    expect(adapter.calls).toBe(1);

    const stored = await readResult(workdir, "hello");
    expect(stored?.runs).toHaveLength(1);
    expect(stored?.runs[0]?.adapterVersion).toBe("codex-cli 0.0.0-test");
    expect(stored?.runs[0]?.workdirDiff).toContain("hello.txt");
    expect(stored?.fingerprint).toMatch(/^sha256:/);
  });

  it("replays on a fingerprint hit without calling the adapter; --force runs live", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    const replay = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(replay.mode).toBe("replay");
    expect(replay.state).toBe("healthy");
    expect(adapter.calls).toBe(1);

    const forced = await runFixture({ workdir, fixture: "hello", adapter, force: true, adapterVersion: version });
    expect(forced.mode).toBe("live");
    expect(adapter.calls).toBe(2);
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(2);
  });

  it("re-grades the whole window against current expectations on replay", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });

    // Tighten the expectation so the recorded run no longer satisfies it.
    // Expectations are OUTSIDE the fingerprint, so this stays a replay hit.
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(helloManifest({ expectations: [{ kind: "fileContains", path: "hello.txt", text: "goodbye" }] }), null, 2) + "\n",
    );
    const replay = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(replay.mode).toBe("replay");
    expect(replay.state).toBe("failing");
    expect(adapter.calls).toBe(1);
    // The persisted grade reflects the re-grade.
    expect((await readResult(workdir, "hello"))?.runs[0]?.grade.pass).toBe(false);
  });

  it("resets history when the fingerprint changes", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    await runFixture({ workdir, fixture: "hello", adapter, force: true, adapterVersion: version });
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(2);

    await writeFile(join(dir, "manifest.json"), JSON.stringify(helloManifest({ prompt: "a different prompt" }), null, 2) + "\n");
    const report = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(report.mode).toBe("live");
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(1);
  });

  it("records a failing grade and derives flaky from a mixed window", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const good = evalAdapter({ "hello.txt": "hello\n" });
    const bad = evalAdapter({ "wrong.txt": "nope\n" });

    const first = await runFixture({ workdir, fixture: "hello", adapter: good, adapterVersion: version });
    expect(first.state).toBe("healthy");
    const second = await runFixture({ workdir, fixture: "hello", adapter: bad, force: true, adapterVersion: version });
    expect(second.latestGrade.pass).toBe(false);
    expect(second.state).toBe("flaky");
  });
});

describe("checkFixture", () => {
  it("reports stale when there is no result file", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: true,
      state: null,
    });
  });

  it("reports stale on a fingerprint mismatch after inputs change", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(helloManifest({ prompt: "changed" }), null, 2) + "\n");
    const report = await checkFixture({ workdir, fixture: "hello", adapterName: "codex" });
    expect(report.stale).toBe(true);
  });

  it("re-grades from the recorded diff: expectation edits flip state with no new run", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });

    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: false,
      state: "healthy",
    });

    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(helloManifest({ expectations: [{ kind: "fileContains", path: "hello.txt", text: "goodbye" }] }), null, 2) + "\n",
    );
    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: false,
      state: "failing",
    });
  });

  it("re-runs commandSucceeds against the reconstructed workdir", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", {
      manifest: manifestFor("hello", {
        expectations: [{ kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('hello.txt')\"" }],
      }),
    });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });
    const report = await checkFixture({ workdir, fixture: "hello", adapterName: "codex" });
    expect(report.state).toBe("healthy");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/eval-runner.test.ts`
Expected: FAIL — cannot resolve `../src/evals/runner.js`.

- [ ] **Step 4: Implement `src/evals/runner.ts`**

```ts
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter } from "../adapter/types.js";
import { computeFingerprint } from "./fingerprint.js";
import { gradeFixture } from "./grade.js";
import type { Grade } from "./grade.js";
import { FIXTURES_DIR, loadManifest } from "./manifest.js";
import type { FixtureManifest } from "./manifest.js";
import { applyRecordedDiff, materializeWorkdir } from "./materialize.js";
import { appendRun, readResult, writeResult } from "./results.js";
import type { RecordedRun } from "./results.js";
import { deriveState } from "./state.js";
import type { FixtureState } from "./state.js";

const execFileAsync = promisify(execFile);

/** Best-effort `<adapter> --version` for drift attribution; "unknown" on any failure. */
export async function defaultAdapterVersion(adapter: Adapter): Promise<string> {
  try {
    const { stdout } = await execFileAsync(adapter.name, ["--version"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/** Re-materialize the seed, apply the recorded diff, and grade against current expectations. */
async function regrade(fixtureDir: string, manifest: FixtureManifest, run: RecordedRun): Promise<Grade> {
  const workdir = await materializeWorkdir(fixtureDir);
  try {
    await applyRecordedDiff(workdir, run.workdirDiff);
    return await gradeFixture({ manifest, envelope: run.envelope, workdir, workdirDiff: run.workdirDiff });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export interface RunReport {
  fixture: string;
  mode: "live" | "replay";
  state: FixtureState;
  latestGrade: Grade;
}

export async function runFixture(opts: {
  workdir: string;
  fixture: string;
  adapter: Adapter;
  force?: boolean;
  adapterVersion?: (adapter: Adapter) => Promise<string>;
  now?: () => Date;
}): Promise<RunReport> {
  const fixtureDir = join(opts.workdir, FIXTURES_DIR, opts.fixture);
  const manifest = await loadManifest(fixtureDir);
  const fingerprint = await computeFingerprint({ fixtureDir, manifest, adapterName: opts.adapter.name });
  const existing = await readResult(opts.workdir, opts.fixture);

  if (opts.force !== true && existing !== null && existing.fingerprint === fingerprint && existing.runs.length > 0) {
    // Replay: zero tokens. Re-grade the whole window against current
    // expectations and persist the refreshed grades so `status` stays truthful.
    const runs: RecordedRun[] = [];
    for (const run of existing.runs) runs.push({ ...run, grade: await regrade(fixtureDir, manifest, run) });
    await writeResult(opts.workdir, { ...existing, runs });
    const latest = runs[0];
    if (latest === undefined) throw new Error("unreachable: replay with an empty run history");
    return {
      fixture: opts.fixture,
      mode: "replay",
      state: deriveState(runs.map((r) => r.grade.pass)),
      latestGrade: latest.grade,
    };
  }

  // Live turn: attended, token-spending, through the same adapter seam as `tackle turn`.
  const turnWorkdir = await materializeWorkdir(fixtureDir);
  try {
    const result = await opts.adapter.run({
      prompt: manifest.prompt,
      workdir: turnWorkdir,
      effort: manifest.effort,
      timeoutMs: manifest.timeoutSeconds * 1000,
    });
    const envelope = {
      status: result.status,
      summary: result.summary,
      authorship: result.authorship,
      usage: result.usage,
    };
    const grade = await gradeFixture({ manifest, envelope, workdir: turnWorkdir, workdirDiff: result.workdirDiff });
    const run: RecordedRun = {
      at: (opts.now?.() ?? new Date()).toISOString(),
      adapterVersion: await (opts.adapterVersion ?? defaultAdapterVersion)(opts.adapter),
      envelope,
      workdirDiff: result.workdirDiff,
      grade,
    };
    const updated = appendRun(existing, opts.fixture, fingerprint, run);
    await writeResult(opts.workdir, updated);
    return {
      fixture: opts.fixture,
      mode: "live",
      state: deriveState(updated.runs.map((r) => r.grade.pass)),
      latestGrade: grade,
    };
  } finally {
    await rm(turnWorkdir, { recursive: true, force: true });
  }
}

export interface CheckReport {
  fixture: string;
  stale: boolean;
  state: FixtureState | null; // null iff stale
}

/** CI gate: replay-only, read-only, zero tokens. Stale is a failure, never a silent skip. */
export async function checkFixture(opts: {
  workdir: string;
  fixture: string;
  adapterName: string;
}): Promise<CheckReport> {
  const fixtureDir = join(opts.workdir, FIXTURES_DIR, opts.fixture);
  const manifest = await loadManifest(fixtureDir);
  const fingerprint = await computeFingerprint({ fixtureDir, manifest, adapterName: opts.adapterName });
  const existing = await readResult(opts.workdir, opts.fixture);
  if (existing === null || existing.fingerprint !== fingerprint || existing.runs.length === 0) {
    return { fixture: opts.fixture, stale: true, state: null };
  }
  const passes: boolean[] = [];
  for (const run of existing.runs) passes.push((await regrade(fixtureDir, manifest, run)).pass);
  return { fixture: opts.fixture, stale: false, state: deriveState(passes) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/eval-runner.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/evals/runner.ts test/helpers/evals.ts test/eval-runner.test.ts
git commit -m "Add eval runner: live runs, replay re-grading, CI check"
```

---

### Task 8: CLI — `tackle eval run | status | check`

**Files:**
- Modify: `src/cli.ts` (add `registerEvalCommands`, call it next to `registerMapCommands(program, writeOut)` at the bottom of `buildProgram`)
- Test: `test/cli-eval.test.ts`

**Interfaces:**
- Consumes: `listFixtures` (Task 1), `readResult` (Task 5), `deriveState` (Task 6), `runFixture`/`checkFixture` (Task 7), the existing `buildProgram` options (`opts.adapter`, `writeOut`), `CodexAdapter`.
- Produces: `tackle eval run [fixtures...] [--cwd] [--force]`, `tackle eval status [--cwd]`, `tackle eval check [--cwd]`. Exit-code contract:
  - `run`: nonzero if any fixture's latest grade fails (or no fixtures exist).
  - `status`: always 0 (except no fixtures is still 0 — informational command).
  - `check`: nonzero on any stale or `failing` fixture (or no fixtures); `flaky` warns but exits 0.

- [ ] **Step 1: Write the failing tests**

Create `test/cli-eval.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

afterEach(() => {
  process.exitCode = undefined;
});

async function cli(argv: string[], adapter = evalAdapter({ "hello.txt": "hello\n" })) {
  const out: string[] = [];
  const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(argv, { from: "user" });
  return { out: out.join(""), adapter };
}

const passingManifest = manifestFor("hello", {
  expectations: [
    { kind: "status", equals: "completed" },
    { kind: "fileContains", path: "hello.txt", text: "hello" },
  ],
});

describe("tackle eval run", () => {
  it("live-runs all fixtures, prints mode and verdict, exits 0 on pass", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "run", "--cwd", workdir]);
    expect(out).toContain("hello: live pass (healthy)");
    expect(process.exitCode).toBeUndefined();
  });

  it("replays on the second invocation and says so", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await cli(["eval", "run", "--cwd", workdir], adapter);
    const { out } = await cli(["eval", "run", "--cwd", workdir], adapter);
    expect(out).toContain("hello: replay pass (healthy)");
    expect(adapter.calls).toBe(1);
  });

  it("prints per-expectation failures and exits nonzero on a failing grade", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "run", "--cwd", workdir], evalAdapter({ "wrong.txt": "nope\n" }));
    expect(out).toContain("hello: live fail");
    expect(out).toContain("fail fileContains: hello.txt does not exist");
    expect(process.exitCode).toBe(1);
  });

  it("runs only the named fixtures and errors when there are none at all", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "a", { manifest: manifestFor("a") });
    await makeFixture(workdir, "b", { manifest: manifestFor("b") });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    const { out } = await cli(["eval", "run", "b", "--cwd", workdir], adapter);
    expect(out).toContain("b:");
    expect(out).not.toContain("a:");

    const empty = await tempWorkdir();
    const result = await cli(["eval", "run", "--cwd", empty]);
    expect(result.out).toContain("no fixtures");
    expect(process.exitCode).toBe(1);
  });
});

describe("tackle eval status", () => {
  it("prints the state table from stored results and always exits 0", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    await makeFixture(workdir, "unrun", { manifest: manifestFor("unrun") });
    await cli(["eval", "run", "hello", "--cwd", workdir]);
    const { out } = await cli(["eval", "status", "--cwd", workdir]);
    expect(out).toMatch(/hello\s+healthy\s+1\/1\s+1 run/);
    expect(out).toMatch(/unrun\s+no runs/);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("tackle eval check", () => {
  it("fails on a stale (never-run) fixture with re-run guidance", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "check", "--cwd", workdir]);
    expect(out).toContain("hello: stale");
    expect(out).toContain("tackle eval run hello");
    expect(process.exitCode).toBe(1);
  });

  it("passes on healthy, fails on failing, warns-but-passes on flaky", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    await cli(["eval", "run", "--cwd", workdir]);
    let result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: healthy");
    expect(process.exitCode).toBeUndefined();

    // Mixed window -> flaky -> warn, exit 0. The force-run itself fails its
    // grade and sets exitCode 1; clear it so the assertion below is about check.
    await cli(["eval", "run", "--cwd", workdir, "--force"], evalAdapter({ "wrong.txt": "x\n" }));
    process.exitCode = undefined;
    result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: flaky");
    expect(process.exitCode).toBeUndefined();

    // Expectation nobody can meet -> every run re-grades to fail -> failing -> exit 1.
    const dir = join(workdir, "evals", "fixtures", "hello");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(manifestFor("hello", { expectations: [{ kind: "fileExists", path: "never.txt" }] }), null, 2) + "\n",
    );
    result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: failing");
    expect(process.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli-eval.test.ts`
Expected: FAIL — `error: unknown command 'eval'`.

- [ ] **Step 3: Implement the command group in `src/cli.ts`**

Add imports at the top (alongside the existing map imports):

```ts
import { listFixtures } from "./evals/manifest.js";
import { readResult } from "./evals/results.js";
import { checkFixture, runFixture } from "./evals/runner.js";
import { deriveState } from "./evals/state.js";
```

Add below `registerMapCommands` (same file level):

```ts
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function registerEvalCommands(
  program: Command,
  writeOut: (s: string) => void,
  defaultAdapter: () => Adapter,
): void {
  const evalCmd = program.command("eval").description("Live-turn eval fixtures with model-free grading");

  evalCmd
    .command("run")
    .description("Run fixtures: replay-grade on a fingerprint hit, live turn on a miss")
    .argument("[fixtures...]", "fixture names (default: all)")
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("--force", "run a live turn even on a fingerprint hit")
    .action(async (fixtures: string[], options: { cwd: string; force?: boolean }) => {
      const names = fixtures.length > 0 ? fixtures : await listFixtures(options.cwd);
      if (names.length === 0) {
        writeOut("no fixtures under evals/fixtures\n");
        process.exitCode = 1;
        return;
      }
      const adapter = defaultAdapter();
      for (const name of names) {
        const report = await runFixture({
          workdir: options.cwd,
          fixture: name,
          adapter,
          force: options.force === true,
        });
        const verdict = report.latestGrade.pass ? "pass" : "fail";
        writeOut(`${name}: ${report.mode} ${verdict} (${report.state})\n`);
        for (const g of report.latestGrade.expectations) {
          if (!g.pass) writeOut(`  fail ${g.expectation.kind}: ${g.message}\n`);
        }
        if (!report.latestGrade.pass) process.exitCode = 1;
      }
    });

  evalCmd
    .command("status")
    .description("Show fixture states from recorded results (always exits 0)")
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const names = await listFixtures(options.cwd);
      if (names.length === 0) {
        writeOut("no fixtures under evals/fixtures\n");
        return;
      }
      for (const name of names) {
        const result = await readResult(options.cwd, name);
        const latest = result?.runs[0];
        if (result === null || latest === undefined) {
          writeOut(`${name.padEnd(24)} no runs\n`);
          continue;
        }
        const passes = result.runs.map((r) => r.grade.pass);
        const state = deriveState(passes);
        const rate = `${passes.filter(Boolean).length}/${passes.length}`;
        const runs = `${result.runs.length} run${result.runs.length === 1 ? "" : "s"}`;
        const age = formatAge(Date.now() - Date.parse(latest.at));
        const model = latest.envelope.authorship.model ?? "default";
        writeOut(`${name.padEnd(24)} ${state.padEnd(8)} ${rate.padEnd(6)} ${runs.padEnd(8)} ${age.padEnd(10)} ${model}\n`);
      }
    });

  evalCmd
    .command("check")
    .description("Replay-only CI gate: stale or failing blocks; flaky warns")
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const names = await listFixtures(options.cwd);
      if (names.length === 0) {
        writeOut("no fixtures under evals/fixtures\n");
        process.exitCode = 1;
        return;
      }
      const adapterName = defaultAdapter().name;
      for (const name of names) {
        const report = await checkFixture({ workdir: options.cwd, fixture: name, adapterName });
        if (report.stale) {
          writeOut(`${name}: stale — fixture inputs changed since the recorded runs; re-run locally: tackle eval run ${name}\n`);
          process.exitCode = 1;
          continue;
        }
        writeOut(`${name}: ${report.state}\n`);
        if (report.state === "failing") process.exitCode = 1;
      }
    });
}
```

Wire it up inside `buildProgram`, right after the existing `registerMapCommands(program, writeOut);` line:

```ts
  registerEvalCommands(program, writeOut, () => opts.adapter ?? new CodexAdapter());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli-eval.test.ts` — expected: PASS.
Run: `npx tsc --noEmit` — expected: clean.

- [ ] **Step 5: Run the whole suite (CLI changes can break sibling tests)**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli-eval.test.ts
git commit -m "Add tackle eval command group: run, status, check"
```

---

### Task 9: End-to-end test — run → result file → check → status

**Files:**
- Test: `test/eval-e2e.test.ts`

**Interfaces:**
- Consumes: everything already built; no new production code. This is the design doc's "one end-to-end test" and additionally proves full-fidelity replay of `commandSucceeds` through the CLI.

- [ ] **Step 1: Write the test**

Create `test/eval-e2e.test.ts`:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("eval end-to-end", () => {
  it("run records a graded result; check and status agree; replay is fully reconstructive", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "create-file", {
      manifest: manifestFor("create-file", {
        prompt: "Create a file named hello.txt containing exactly the word: hello",
        expectations: [
          { kind: "status", equals: "completed" },
          { kind: "billing", equals: "subscription" },
          { kind: "fileExists", path: "hello.txt" },
          { kind: "fileContains", path: "hello.txt", text: "hello" },
          { kind: "diffTouchesOnly", globs: ["hello.txt"] },
          { kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('hello.txt')\"" },
        ],
      }),
      seed: { "README.md": "fixture seed\n" },
    });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    const parse = async (argv: string[]) => {
      const out: string[] = [];
      const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
      program.exitOverride();
      await program.parseAsync(argv, { from: "user" });
      return out.join("");
    };

    // 1. Live run: one adapter call, passing grade, committed-shape result file on disk.
    const runOut = await parse(["eval", "run", "--cwd", workdir]);
    expect(runOut).toContain("create-file: live pass (healthy)");
    expect(adapter.calls).toBe(1);
    await access(join(workdir, "evals", "results", "create-file.json"));
    expect(process.exitCode).toBeUndefined();

    // 2. Check: replay-only — reconstructs seed + diff and re-runs every grader,
    //    including commandSucceeds, without touching the adapter.
    const checkOut = await parse(["eval", "check", "--cwd", workdir]);
    expect(checkOut).toContain("create-file: healthy");
    expect(adapter.calls).toBe(1);
    expect(process.exitCode).toBeUndefined();

    // 3. Status: reads the stored window.
    const statusOut = await parse(["eval", "status", "--cwd", workdir]);
    expect(statusOut).toMatch(/create-file\s+healthy\s+1\/1/);

    // 4. Second run replays rather than spending a turn.
    const replayOut = await parse(["eval", "run", "--cwd", workdir]);
    expect(replayOut).toContain("create-file: replay pass (healthy)");
    expect(adapter.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/eval-e2e.test.ts`
Expected: PASS immediately (it exercises already-built code). If it fails, the failure is a real integration bug in Tasks 1–8 — debug there, do not weaken this test.

- [ ] **Step 3: Commit**

```bash
git add test/eval-e2e.test.ts
git commit -m "Add eval end-to-end test across run, check, and status"
```

---

### Task 10: The four committed fixtures

**Files:**
- Create: `evals/fixtures/create-file/manifest.json`
- Create: `evals/fixtures/edit-file/manifest.json`, `evals/fixtures/edit-file/seed/greeting.txt`
- Create: `evals/fixtures/passing-test/manifest.json`, `evals/fixtures/passing-test/seed/package.json`
- Create: `evals/fixtures/error-normalization/manifest.json`
- Test: `test/eval-fixtures.test.ts`

**Interfaces:**
- Consumes: `loadManifest`, `listFixtures`, `FIXTURES_DIR` (Task 1).
- Produces: the v1 fixture set. No live runs here — Task 12 records those.

- [ ] **Step 1: Write the failing test**

Create `test/eval-fixtures.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, listFixtures, loadManifest } from "../src/evals/manifest.js";

describe("committed fixtures", () => {
  it("every fixture in the repo has a valid manifest", async () => {
    const names = await listFixtures(process.cwd());
    expect(names).toEqual(["create-file", "edit-file", "error-normalization", "passing-test"]);
    for (const name of names) {
      const manifest = await loadManifest(join(process.cwd(), FIXTURES_DIR, name));
      expect(manifest.name).toBe(name);
      expect(manifest.expectations.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/eval-fixtures.test.ts`
Expected: FAIL — `listFixtures` returns `[]` (no `evals/` dir yet).

- [ ] **Step 3: Create the fixtures**

`evals/fixtures/create-file/manifest.json` (the Phase 0 smoke, verbatim from the design doc):

```json
{
  "name": "create-file",
  "description": "Phase 0 smoke codified: trivial write task completes on subscription billing",
  "prompt": "Create a file named hello.txt containing exactly the word: hello",
  "effort": "low",
  "timeoutSeconds": 300,
  "expectations": [
    { "kind": "status", "equals": "completed" },
    { "kind": "billing", "equals": "subscription" },
    { "kind": "fileExists", "path": "hello.txt" },
    { "kind": "fileContains", "path": "hello.txt", "text": "hello" }
  ]
}
```

`evals/fixtures/edit-file/manifest.json`:

```json
{
  "name": "edit-file",
  "description": "Seeded edit with no collateral damage: diffTouchesOnly pins the blast radius",
  "prompt": "In greeting.txt, replace the word world with tackle. Change nothing else and create no new files.",
  "effort": "low",
  "timeoutSeconds": 300,
  "expectations": [
    { "kind": "status", "equals": "completed" },
    { "kind": "billing", "equals": "subscription" },
    { "kind": "fileContains", "path": "greeting.txt", "text": "hello tackle" },
    { "kind": "diffTouchesOnly", "globs": ["greeting.txt"] }
  ]
}
```

`evals/fixtures/edit-file/seed/greeting.txt`:

```
hello world
```

(one line, trailing newline)

`evals/fixtures/passing-test/manifest.json` (deviation from the design doc: `node --test` instead of `npx vitest run` — see the plan header):

```json
{
  "name": "passing-test",
  "description": "Task must produce a test that actually passes, verified by running it",
  "prompt": "Write math.js exporting an add(a, b) function that returns a + b, and math.test.js that tests add using node:test and node:assert. The tests must pass under `node --test`. Do not modify package.json.",
  "effort": "low",
  "timeoutSeconds": 600,
  "expectations": [
    { "kind": "status", "equals": "completed" },
    { "kind": "billing", "equals": "subscription" },
    { "kind": "fileExists", "path": "math.test.js" },
    { "kind": "commandSucceeds", "command": "node --test" }
  ]
}
```

`evals/fixtures/passing-test/seed/package.json`:

```json
{
  "name": "passing-test-fixture",
  "type": "commonjs",
  "private": true
}
```

`evals/fixtures/error-normalization/manifest.json` (engineered failure: the timeout is far too short for any real turn, pinning that the envelope normalizes to the closed-enum `timeout` rather than leaking free text):

```json
{
  "name": "error-normalization",
  "description": "Engineered timeout: status must normalize to the closed enum, not leak free text",
  "prompt": "Read every file in this repository carefully, then write an exhaustive 2000-word analysis to analysis.md.",
  "effort": "low",
  "timeoutSeconds": 5,
  "expectations": [
    { "kind": "status", "equals": "timeout" },
    { "kind": "billing", "equals": "subscription" }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/eval-fixtures.test.ts` — expected: PASS.
Run: `npx vitest run` — expected: whole suite PASS.

- [ ] **Step 5: Commit**

```bash
git add evals/ test/eval-fixtures.test.ts
git commit -m "Add the v1 eval fixture set"
```

---

### Task 11: Minimal CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the built CLI (`node dist/cli.js eval check`). No credentials, no tokens, deterministic.
- Note: this repo uses **pnpm** (`packageManager: pnpm@10.16.1`, `pnpm-lock.yaml`); the design doc's `npm ci` is corrected accordingly. Node 26 per the design doc.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx tsc --noEmit
      - run: npx vitest run
      - run: pnpm build
      - run: node dist/cli.js eval check
```

- [ ] **Step 2: Verify the workflow locally as far as possible**

Run each step's command locally from the repo root:

```bash
npx tsc --noEmit && npx vitest run && pnpm build && node dist/cli.js eval check
```

Expected at this point in the plan: typecheck, tests, and build PASS; `eval check` exits **1** with four `stale` lines — correct behavior, because no live runs have been recorded yet. Task 12 turns it green. Do NOT weaken `check` to tolerate missing results.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Add CI: typecheck, tests, build, eval check"
```

---

### Task 12: Dogfood — record the first live runs (ATTENDED)

**⚠️ This task is NOT for a subagent.** It spends real tokens through the local codex subscription and must run in the main (attended) session, after Tasks 1–11 are complete and reviewed. It exists in the plan so CI is green from the first commit that hits main.

**Files:**
- Create (by running, not by hand): `evals/results/create-file.json`, `evals/results/edit-file.json`, `evals/results/passing-test.json`, `evals/results/error-normalization.json`

- [ ] **Step 1: Build and live-run every fixture**

```bash
pnpm build
node dist/cli.js eval run
```

Expected: `create-file`, `edit-file`, `passing-test` report `live pass (healthy)`; `error-normalization` reports `live pass (healthy)` (its recorded status is `timeout`, which is what it asserts). Overall exit 0. Roughly 3 short low-effort turns plus one 5-second timeout.

If a fixture fails its live run, inspect the per-expectation failure lines: a wrong expectation is a fixture bug (fix the manifest — grading changes don't invalidate the recording); a wrong recording is a harness bug (investigate before committing anything).

- [ ] **Step 2: Verify the CI gate goes green and the state table reads sanely**

```bash
node dist/cli.js eval check && node dist/cli.js eval status
```

Expected: four `healthy` lines, exit 0; status shows `1/1`, `1 run`, a fresh age, and the model.

- [ ] **Step 3: Commit the recorded results**

```bash
git add evals/results
git commit -m "Record first live eval runs for the v1 fixture set"
```

---

## Execution notes

- **Task order matters:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 2+3 are independent of each other (both need only Task 1) and may run in parallel worktrees; likewise 5+6 (both need Task 4 only... Task 6 needs nothing). Everything else is sequential.
- **Verification before done, per task:** the named test file passes, `npx tsc --noEmit` is clean, and from Task 8 onward the full `npx vitest run` suite passes.
- **After the final task:** run the full suite once more, then `tackle map build` if the session's conventions call for refreshing the test map after adding source files.
