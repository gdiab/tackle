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
async function regrade(
  fixtureDir: string,
  manifest: FixtureManifest,
  run: Pick<RecordedRun, "envelope" | "workdirDiff">,
): Promise<Grade> {
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
  /** Set only when a live run's grade failed: the turn workdir was kept (not rm'd) for debugging. */
  debugWorkdir?: string;
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
  let grade: Grade | undefined;
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
    // Grade the same reconstruction (seed + applied diff) that a replay will
    // grade, not the live turn workdir — the turn workdir also contains
    // `.tackle/`, so grading it directly could pass live and fail every replay.
    grade = await regrade(fixtureDir, manifest, { envelope, workdirDiff: result.workdirDiff });
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
      ...(grade.pass ? {} : { debugWorkdir: turnWorkdir }),
    };
  } finally {
    // Keep the turn workdir when the live grade failed: `.tackle/transcripts/*`
    // inside it is the debugging evidence for why the turn failed. Clean up
    // on a pass (or if we never got a grade at all, e.g. the turn threw).
    if (grade === undefined || grade.pass) {
      await rm(turnWorkdir, { recursive: true, force: true });
    }
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
