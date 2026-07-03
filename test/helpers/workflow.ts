import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter, TurnRequest, TurnResult } from "../../src/adapter/types.js";
import { EMPTY_USAGE } from "../../src/adapter/types.js";
import { sha256 } from "../../src/workflow/hash.js";
import type { Presenter } from "../../src/workflow/presenter.js";
import { writeWorkflowState } from "../../src/workflow/state.js";
import type { WorkflowState } from "../../src/workflow/types.js";

const execFileAsync = promisify(execFile);

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
  name = "fake",
): Adapter & { prompts: string[] } {
  let call = 0;
  const prompts: string[] = [];
  return {
    name,
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

/** Presenter that records every inform() message for assertions. */
export function capturingPresenter(approve: boolean): Presenter & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    askApproval: async () => approve,
    inform: (message: string) => {
      messages.push(message);
    },
  };
}

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
