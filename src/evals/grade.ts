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
  // Only match `---`/`+++` header lines while "armed" by a preceding `diff --git`
  // line, and disarm at the next hunk (`@@`). Without this, a removed content
  // line that itself reads like a header (e.g. `-- a/sneaky.ts` rendered as
  // `--- a/sneaky.ts`) would be mistaken for a real path header.
  let armed = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      armed = true;
      continue;
    }
    if (line.startsWith("@@")) {
      armed = false;
      continue;
    }
    if (!armed) continue;
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
