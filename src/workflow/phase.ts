import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Effort, TurnResult } from "../adapter/types.js";
import { readTestMap, TEST_MAP_FILE } from "../map/store.js";
import { readArtifact, removeArtifact } from "./artifacts.js";
import { sha256 } from "./hash.js";
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

export function toTurnRecord(result: TurnResult): TurnRecord {
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
export async function presentGate(
  phase: PhaseName,
  state: WorkflowState,
  opts: Pick<RunPhaseOptions, "workdir" | "presenter">,
): Promise<boolean> {
  const def = SPINE[phase];
  const phaseState = state.phases[phase];
  if (phaseState === undefined) throw new Error(`no ${phase} state to present`);
  const artifact = await readArtifact(opts.workdir, def.artifact);
  if (artifact === null) {
    opts.presenter.inform(
      `${def.artifact} is missing or blank; cannot present the ${phase} gate — re-run \`tackle ${phase} --redo\``,
    );
    return false;
  }
  const approved = await opts.presenter.askApproval({
    title: `${phase} phase awaiting approval`,
    artifactPath: def.artifact,
    summary: phaseState.lastTurn?.summary ?? "",
    ...(phase === "build" ? { detail: `frozen diff: ${BUILD_DIFF_FILE}` } : {}),
  });
  if (approved) {
    phaseState.status = "approved";
    // Pin what was approved: later consumers verify against these hashes so a
    // subsequent turn cannot silently rewrite an already-approved artifact.
    phaseState.artifactHash = sha256(artifact);
    if (phase === "build") {
      const diff = await readArtifact(opts.workdir, BUILD_DIFF_FILE);
      if (diff !== null) phaseState.diffHash = sha256(diff);
    }
    await writeWorkflowState(opts.workdir, state);
  }
  return approved;
}

export async function runPhase(opts: RunPhaseOptions): Promise<PhaseOutcome> {
  if (opts.phase === "review") {
    throw new Error("the review phase runs through runReviewPhase, not runPhase");
  }
  const def = SPINE[opts.phase];
  const { presenter, workdir } = opts;
  let state = await readWorkflowState(workdir);

  // -- fresh guard: must have an entry-capable invocation --------------------
  if (state !== null && opts.fresh === true && !opts.canEnter) {
    presenter.inform(
      `--fresh starts a new workflow, so it needs an entry-capable invocation ` +
        `(\`tackle specs\`, \`tackle plan --skip-specs\`, or \`tackle build --trivial\`)`,
    );
    return "halted";
  }

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
  }

  // -- entry-flag guard: an entry-capable command mid-workflow must target the
  // workflow's own entry phase, or it silently degrades into an amend. -------
  if (state !== null && opts.canEnter && opts.fresh !== true && opts.phase !== state.entry) {
    presenter.inform(
      `a workflow is already in progress (entered at ${state.entry}); ` +
        `pass --fresh to start a new workflow at ${opts.phase}`,
    );
    return "halted";
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
      if (pred === "review") {
        presenter.inform(`review is awaiting approval; run \`tackle review\` to approve and commit`);
        return "halted";
      }
      const ok = await presentGate(pred, state, opts);
      if (!ok) return "rejected";
    }
  }

  // -- own-phase resume: don't re-run a turn whose artifact awaits judgment ----
  const own = state.phases[opts.phase];
  if (own !== undefined && opts.redo !== true) {
    if (own.status === "approved") {
      if (opts.request !== undefined) {
        presenter.inform(`ignoring the request argument; pass --redo to amend an already-approved ${opts.phase}`);
      }
      presenter.inform(`${opts.phase} is already approved; pass --redo to run it again`);
      return "approved";
    }
    if (own.status === "awaiting_approval") {
      if (opts.request !== undefined) {
        presenter.inform(
          `ignoring the request argument; pass --redo to amend ${opts.phase} instead of re-presenting the gate`,
        );
      }
      return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
    }
  }

  // Amending the request only takes effect when a turn is actually about to run:
  // the two early returns above must leave a re-presented (or already-approved)
  // artifact's provenance intact rather than silently rewriting the ask it was
  // built from.
  if (opts.request !== undefined) {
    state.request = opts.request;
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
  // A stale artifact must not satisfy the gate for a fresh turn. Trade-off: a
  // process killed between turn completion and the state write below will
  // re-run (and re-bill) the turn on the next invocation, since there is no
  // way to tell "artifact written, state write pending" from "no turn ran yet".
  await removeArtifact(workdir, def.artifact);
  await writeWorkflowState(workdir, state);

  // -- gather the turn's inputs (selective load) --------------------------------
  const policy = await loadPolicyConfig(workdir);
  const questionsAndAnswers = (await readArtifact(workdir, def.questionsFile)) ?? undefined;
  const inputs: Array<{ name: string; path: string; content: string }> = [];
  for (const inputPhase of def.inputs) {
    const content = await readArtifact(workdir, SPINE[inputPhase].artifact);
    const pinned = state.phases[inputPhase]?.artifactHash;
    if (content === null) {
      // Missing inputs are phases skipped by the entry point — but an approved
      // phase pinned a non-blank artifact, so pin-present + missing/blank = tamper.
      if (pinned !== undefined) {
        presenter.inform(
          `${SPINE[inputPhase].artifact} is missing or blank but ${inputPhase} was approved; ` +
            `re-run \`tackle ${inputPhase} --redo\` to regenerate and re-approve it`,
        );
        return "halted";
      }
      continue;
    }
    if (pinned !== undefined && sha256(content) !== pinned) {
      presenter.inform(
        `${SPINE[inputPhase].artifact} changed after ${inputPhase} was approved; ` +
          `re-run \`tackle ${inputPhase} --redo\` to regenerate and re-approve it`,
      );
      return "halted";
    }
    inputs.push({ name: inputPhase, path: SPINE[inputPhase].artifact, content });
  }

  // SPEC advisory-until-map: the build prompt gains targeted test-first
  // instructions only when a map exists; a corrupt map degrades to no map.
  let testMapPath: string | undefined;
  if (opts.phase === "build") {
    try {
      if ((await readTestMap(workdir)) !== null) testMapPath = TEST_MAP_FILE;
    } catch {
      presenter.inform(`warning: ${TEST_MAP_FILE} is unreadable; running build without the test map`);
    }
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
      ...(testMapPath === undefined ? {} : { testMapPath }),
    });
    const result = await opts.adapter.run({
      prompt,
      workdir,
      effort: opts.effort ?? "medium",
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    lastTurn = result;

    // Billing gate: fail closed — only "subscription" passes (SPEC "Gate
    // semantics": billing_type == subscription). No retry — re-running would
    // bill metered again, or leave an unverified auth mode unverified again.
    if (result.usage.billingType !== "subscription") {
      state.phases[opts.phase] = { status: "halted", lastTurn: toTurnRecord(result) };
      await writeWorkflowState(workdir, state);
      presenter.inform(
        result.usage.billingType === "metered"
          ? "halted: turn billed metered; fix adapter auth before re-running (subscription-before-API gate)"
          : "halted: could not verify subscription billing (billing type unknown); refusing to proceed " +
              "— check the adapter's credentials (Claude Code login, or ~/.codex/auth.json for codex)",
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

  // Success: this phase's own questions file (if any) is spent. Removing it
  // here — only on success — keeps a stale round of Q&A from poisoning a
  // future --redo prompt, while leaving the clarification loop (answer in
  // place, re-run) untouched, since that path never reaches here.
  await removeArtifact(workdir, def.questionsFile);

  state.phases[opts.phase] = { status: "awaiting_approval", lastTurn: toTurnRecord(completed) };
  await writeWorkflowState(workdir, state);
  return (await presentGate(opts.phase, state, opts)) ? "approved" : "rejected";
}
