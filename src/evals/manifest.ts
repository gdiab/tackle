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
