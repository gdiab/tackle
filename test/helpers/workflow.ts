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
