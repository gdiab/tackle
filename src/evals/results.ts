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
  // The window invariant is enforced on read, not just on write: a hand-edited or
  // merge-mangled file with more than RUN_WINDOW runs must not silently widen the
  // state-derivation window.
  result.runs = result.runs.slice(0, RUN_WINDOW);
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
