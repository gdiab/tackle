import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Effort, TurnResult } from "../adapter/types.js";
import { readArtifact, removeArtifact } from "./artifacts.js";
import type { Presenter } from "./presenter.js";
import { buildPhasePrompt } from "./prompts.js";
import { BUILD_DIFF_FILE, effectivePredecessor, PHASE_ORDER, SPINE } from "./spine.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "./state.js";
import type { PhaseName, TurnRecord, WorkflowState } from "./types.js";

export type PhaseOutcome = "approved" | "rejected" | "needs_clarification" | "halted";

export interface RunPhaseOptions {
  phase: PhaseName;
  workdir: string;
  adapter: Adapter;
  presenter: Presenter;
  /** true when this invocation may start a new workflow at this phase (specs, --skip-specs, --trivial). */
  canEnter: boolean;
  request?: string;
  /** Discard any in-progress workflow and start over at this phase (needs canEnter). */
  fresh?: boolean;
  /** Re-run this phase's turn even if its artifact is approved or awaiting approval. */
  redo?: boolean;
  effort?: Effort;
  model?: string;
  timeoutMs?: number;
}

function toTurnRecord(result: TurnResult): TurnRecord {
  return {
    status: result.status,
    summary: result.summary,
    authorship: result.authorship,
    billingType: result.usage.billingType,
    transcriptRef: result.transcriptRef,
    sessionId: result.sessionId,
  };
}

/**
 * Present the blocking approval gate for a phase whose artifact is on disk.
 * Serves both the end-of-phase gate and resume: a pending gate from an earlier
 * (possibly killed) run is re-presented by the next command that needs it.
 */
async function presentGate(
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
    await writeWorkflowState(opts.workdir, state);
  }
  return approved;
}

export async function runPhase(opts: RunPhaseOptions): Promise<PhaseOutcome> {
  const def = SPINE[opts.phase];
  const { presenter, workdir } = opts;
  let state = await readWorkflowState(workdir);

  // -- workflow start / reset -------------------------------------------------
  if (state === null || (opts.fresh === true && opts.canEnter)) {
    if (!opts.canEnter) {
      presenter.inform(`no workflow in progress; start one with \`tackle specs "<request>"\``);
      return "halted";
    }
    if (opts.request === undefined) {
      presenter.inform(`starting a workflow at ${opts.phase} requires a request argument`);
      return "halted";
    }
    state = { version: 1, request: opts.request, entry: opts.phase, phases: {} };
    for (const p of PHASE_ORDER) {
      await removeArtifact(workdir, SPINE[p].artifact);
      await removeArtifact(workdir, SPINE[p].questionsFile);
    }
    await removeArtifact(workdir, BUILD_DIFF_FILE);
    await writeWorkflowState(workdir, state);
  } else if (opts.request !== undefined) {
    state.request = opts.request; // amending the ask on a re-run; persisted below
  }

  if (PHASE_ORDER.indexOf(opts.phase) < PHASE_ORDER.indexOf(state.entry)) {
    presenter.inform(
      `this workflow entered at ${state.entry}, so ${opts.phase} is not part of it; ` +
        `pass --fresh to start a new workflow from ${opts.phase}`,
    );
    return "halted";
  }

  // -- predecessor gate (and resume of a pending approval) ---------------------
  const pred = effectivePredecessor(opts.phase, state.entry);
  if (pred !== null) {
    const predState = state.phases[pred];
    if (predState === undefined || predState.status === "halted" || predState.status === "needs_clarification") {
      presenter.inform(`${pred} phase is not complete; run \`tackle ${pred}\` first`);
      return "halted";
    }
    if (predState.status === "awaiting_approval") {
      const ok = await presentGate(pred, state, opts);
      if (!ok) return "rejected";
    }
  }

  // -- own-phase resume: don't re-run a turn whose artifact awaits judgment ----
  const own = state.phases[opts.phase];
  if (own !== undefined && opts.redo !== true) {
    if (own.status === "approved") {
      presenter.inform(`${opts.phase} is already approved; pass --redo to run it again`);
      return "approved";
    }
    if (own.status === "awaiting_approval") {
      return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
    }
  }

  // -- running (or re-running) this phase invalidates everything after it ------
  for (const later of PHASE_ORDER.slice(PHASE_ORDER.indexOf(opts.phase) + 1)) {
    delete state.phases[later];
    await removeArtifact(workdir, SPINE[later].artifact);
    await removeArtifact(workdir, SPINE[later].questionsFile);
  }
  if (PHASE_ORDER.indexOf(opts.phase) <= PHASE_ORDER.indexOf("build")) {
    await removeArtifact(workdir, BUILD_DIFF_FILE);
  }
  // A stale artifact must not satisfy the gate for a fresh turn.
  await removeArtifact(workdir, def.artifact);
  await writeWorkflowState(workdir, state);

  // -- gather the turn's inputs (selective load) --------------------------------
  const policy = await loadPolicyConfig(workdir);
  const questionsAndAnswers = (await readArtifact(workdir, def.questionsFile)) ?? undefined;
  const inputs: Array<{ name: string; path: string; content: string }> = [];
  for (const inputPhase of def.inputs) {
    // Missing inputs are phases skipped by the entry point, not errors.
    const content = await readArtifact(workdir, SPINE[inputPhase].artifact);
    if (content !== null) inputs.push({ name: inputPhase, path: SPINE[inputPhase].artifact, content });
  }

  // -- the turn loop under the deterministic-gate policy ------------------------
  let completed: TurnResult | null = null;
  let lastTurn: TurnResult | null = null;
  let retryNote: string | undefined;
  for (let attempt = 0; attempt <= policy.deterministicRetries; attempt++) {
    const prompt = buildPhasePrompt({
      def,
      request: state.request,
      inputs,
      ...(questionsAndAnswers === undefined ? {} : { questionsAndAnswers }),
      ...(retryNote === undefined ? {} : { retryNote }),
    });
    const result = await opts.adapter.run({
      prompt,
      workdir,
      effort: opts.effort ?? "medium",
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    lastTurn = result;

    // Billing gate: no retry — re-running would bill metered again.
    if (result.usage.billingType === "metered") {
      state.phases[opts.phase] = { status: "halted", lastTurn: toTurnRecord(result) };
      await writeWorkflowState(workdir, state);
      presenter.inform(
        "halted: turn billed metered; fix adapter auth before re-running (subscription-before-API gate)",
      );
      return "halted";
    }
    if (result.status !== "completed") {
      retryNote = `The previous attempt ended with status "${result.status}" before finishing. Start over and complete the phase.`;
      continue;
    }
    const artifact = await readArtifact(workdir, def.artifact);
    if (artifact !== null) {
      completed = result;
      break;
    }
    // Clarification precondition: questions written instead of the artifact.
    // Comparing against the pre-turn content distinguishes a fresh ask from
    // the stale Q&A file that rode into this turn's prompt.
    const questions = await readArtifact(workdir, def.questionsFile);
    if (questions !== null && questions !== questionsAndAnswers) {
      state.phases[opts.phase] = { status: "needs_clarification", lastTurn: toTurnRecord(result) };
      await writeWorkflowState(workdir, state);
      presenter.inform(
        `${opts.phase} needs clarification: answer the questions in ${def.questionsFile} in place, ` +
          `then re-run \`tackle ${opts.phase}\``,
      );
      return "needs_clarification";
    }
    retryNote = `The previous attempt completed without writing ${def.artifact}. You must write that file.`;
  }

  if (completed === null) {
    state.phases[opts.phase] = {
      status: "halted",
      ...(lastTurn === null ? {} : { lastTurn: toTurnRecord(lastTurn) }),
    };
    await writeWorkflowState(workdir, state);
    presenter.inform(
      `${opts.phase} halted after ${policy.deterministicRetries + 1} attempt(s); needs a human decision ` +
        `(last status: ${lastTurn?.status ?? "no turn ran"})`,
    );
    return "halted";
  }

  // The diff is the build phase's artifact of record; freeze it for the review gate.
  if (opts.phase === "build") {
    await writeFile(join(workdir, BUILD_DIFF_FILE), completed.workdirDiff);
    if (completed.workdirDiff.length === 0) presenter.inform("warning: build produced an empty diff");
  }

  state.phases[opts.phase] = { status: "awaiting_approval", lastTurn: toTurnRecord(completed) };
  await writeWorkflowState(workdir, state);
  return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
}
