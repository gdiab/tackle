import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureWorkdirDiff, git, resolveHead } from "../adapter/diff.js";
import type { Adapter, Effort, TurnResult } from "../adapter/types.js";
import { readArtifact, removeArtifact } from "./artifacts.js";
import { sha256 } from "./hash.js";
import type { PhaseOutcome } from "./phase.js";
import { presentGate, toTurnRecord } from "./phase.js";
import type { Presenter } from "./presenter.js";
import { buildReviewPrompt } from "./prompts.js";
import { BUILD_DIFF_FILE, SPINE } from "./spine.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "./state.js";
import type { PolicyConfig, WorkflowState } from "./types.js";
import type { Verdict } from "./verdict.js";
import { blockingFindings, parseVerdict } from "./verdict.js";

export interface RunReviewOptions {
  workdir: string;
  reviewer: Adapter;
  author: Adapter;
  presenter: Presenter;
  redo?: boolean;
  effort?: Effort;
  model?: string;
  timeoutMs?: number;
}

interface RoundRecord {
  round: number;
  verdict: Verdict;
  fixSummary?: string;
}

function renderReviewMd(rounds: RoundRecord[], escalation?: string): string {
  const parts = ["# Review record", ""];
  for (const r of rounds) {
    parts.push(`## Round ${r.round}: ${r.verdict.verdict}`, "");
    for (const f of r.verdict.findings) {
      parts.push(
        `- **${f.severity}** ${f.file}${f.line === undefined ? "" : `:${f.line}`} — ${f.summary}` +
          (f.detail === undefined ? "" : `\n  ${f.detail}`),
      );
    }
    if (r.verdict.findings.length === 0) parts.push("- no findings");
    if (r.fixSummary !== undefined) parts.push("", `Fix turn: ${r.fixSummary}`);
    parts.push("");
  }
  if (escalation !== undefined) parts.push(`## Escalated to human gate`, "", escalation, "");
  return parts.join("\n");
}

function commitMessage(state: WorkflowState): string {
  const firstLine = state.request.split("\n")[0] ?? state.request;
  const subject = firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
  const body = state.phases.build?.lastTurn?.summary ?? "";
  return body.length > 0 ? `${subject}\n\n${body}\n` : `${subject}\n`;
}

/** Billing gate, same fail-closed semantics and copy as runPhase's. */
function billingHaltMessage(billingType: string): string | null {
  if (billingType === "subscription") return null;
  return billingType === "metered"
    ? "halted: turn billed metered; fix adapter auth before re-running (subscription-before-API gate)"
    : "halted: could not verify subscription billing (billing type unknown); refusing to proceed " +
        "— check the adapter's credentials (Claude Code login, or ~/.codex/auth.json for codex)";
}

async function haltReview(
  workdir: string,
  state: WorkflowState,
  lastTurn: TurnResult | null,
  presenter: Presenter,
  message: string,
): Promise<PhaseOutcome> {
  state.phases.review = {
    status: "halted",
    ...(lastTurn === null ? {} : { lastTurn: toTurnRecord(lastTurn) }),
  };
  await writeWorkflowState(workdir, state);
  presenter.inform(message);
  return "halted";
}

/**
 * The bdfinst .review-passed mechanism: nothing is committed unless the staged
 * content hashes to exactly what the reviewer passed. Runs after gate approval.
 */
async function commitReviewed(
  workdir: string,
  state: WorkflowState,
  presenter: Presenter,
): Promise<PhaseOutcome> {
  const review = state.phases.review;
  const expected = review?.reviewedDiffHash;
  if (review === undefined || expected === undefined) {
    return haltReview(workdir, state, null, presenter, "no reviewed-diff hash on record; re-run `tackle review --redo`");
  }
  const diffNow = await captureWorkdirDiff(workdir, await resolveHead(workdir));
  if (sha256(diffNow) !== expected) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      "working tree changed between review and commit; refusing to commit — re-run `tackle review --redo`",
    );
  }
  // .tackle/ is harness state, never part of the reviewed diff (captureWorkdirDiff
  // excludes it) — keep it out of staging too, so the chain holds even in repos
  // that don't gitignore it. Staged-then-unstaged rather than an exclude pathspec:
  // git exits 1 when an ignored path is named in any pathspec, even an exclude.
  await git(workdir, ["add", "-A"]);
  await git(workdir, ["reset", "-q", "HEAD", "--", ".tackle"]);
  // Belt and suspenders: everything the reviewer passed must now be staged.
  const porcelain = await git(workdir, ["status", "--porcelain"]);
  const unstaged = porcelain
    .split("\n")
    .filter((l) => l.length > 0 && !l.slice(3).startsWith(".tackle"))
    .filter((l) => l[1] !== " ");
  if (unstaged.length > 0) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `unexpected unstaged changes after staging; refusing to commit:\n${unstaged.join("\n")}`,
    );
  }
  await git(workdir, ["commit", "-m", commitMessage(state)]);
  const sha = (await git(workdir, ["rev-parse", "HEAD"])).trim();
  review.status = "approved";
  review.commitSha = sha;
  const reviewMd = await readArtifact(workdir, SPINE.review.artifact);
  if (reviewMd !== null) review.artifactHash = sha256(reviewMd);
  await writeWorkflowState(workdir, state);
  presenter.inform(`committed ${sha.slice(0, 10)}`);
  return "approved";
}

async function presentReviewGateAndCommit(
  workdir: string,
  state: WorkflowState,
  presenter: Presenter,
  detail?: string,
): Promise<PhaseOutcome> {
  const review = state.phases.review;
  if (review === undefined) throw new Error("no review state to present");
  const approved = await presenter.askApproval({
    title: "review phase awaiting approval",
    artifactPath: SPINE.review.artifact,
    summary: review.lastTurn?.summary ?? "",
    detail: detail ?? "approval stages and commits the reviewed diff",
  });
  if (!approved) return "rejected";
  return commitReviewed(workdir, state, presenter);
}

export async function runReviewPhase(opts: RunReviewOptions): Promise<PhaseOutcome> {
  const { presenter, workdir } = opts;
  const state = await readWorkflowState(workdir);
  if (state === null) {
    presenter.inform(`no workflow in progress; start one with \`tackle specs "<request>"\``);
    return "halted";
  }

  // -- predecessor: build must be complete (re-present its pending gate) -------
  const buildState = state.phases.build;
  if (buildState === undefined || buildState.status === "halted" || buildState.status === "needs_clarification") {
    presenter.inform("build phase is not complete; run `tackle build` first");
    return "halted";
  }
  if (buildState.status === "awaiting_approval") {
    const ok = await presentGate("build", state, { workdir, presenter });
    if (!ok) return "rejected";
  }

  // -- own-phase resume ---------------------------------------------------------
  const own = state.phases.review;
  if (own !== undefined && opts.redo !== true) {
    if (own.status === "approved") {
      presenter.inform("review is already approved; pass --redo to run it again");
      return "approved";
    }
    if (own.status === "awaiting_approval") {
      return presentReviewGateAndCommit(workdir, state, presenter);
    }
    // halted: fall through and re-run
  }

  // -- re-running review invalidates pr ------------------------------------------
  delete state.phases.pr;
  await removeArtifact(workdir, SPINE.pr.artifact);
  await removeArtifact(workdir, SPINE.pr.questionsFile);
  delete state.phases.review;
  await removeArtifact(workdir, SPINE.review.artifact);
  await removeArtifact(workdir, SPINE.review.questionsFile);
  await writeWorkflowState(workdir, state);

  // -- cross-model gate: fail closed on unknown or same-runtime authorship -------
  const authorAdapter = buildState.lastTurn?.authorship.adapter;
  if (authorAdapter === undefined) {
    return haltReview(workdir, state, null, presenter, "cannot establish build authorship; refusing to review (fail-closed cross-model gate)");
  }
  if (authorAdapter === opts.reviewer.name) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `reviewer runtime (${opts.reviewer.name}) matches the build author; cross-model review requires a different runtime`,
    );
  }

  // -- requirement input: hash-verified specs, else the workflow request ----------
  // An approved phase always pinned a non-blank artifact, so pin-present with the
  // file missing/blank is tamper too (blanking must not demote the requirement).
  let requirement = { label: "workflow request", content: state.request };
  const specsPinned = state.phases.specs?.artifactHash;
  const specsContent = await readArtifact(workdir, SPINE.specs.artifact);
  if (specsContent !== null) {
    if (specsPinned !== undefined && sha256(specsContent) !== specsPinned) {
      return haltReview(
        workdir,
        state,
        null,
        presenter,
        `${SPINE.specs.artifact} changed after specs was approved; re-run \`tackle specs --redo\``,
      );
    }
    requirement = { label: `specs (${SPINE.specs.artifact})`, content: specsContent };
  } else if (specsPinned !== undefined) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `${SPINE.specs.artifact} is missing or blank but specs was approved; re-run \`tackle specs --redo\``,
    );
  }

  // -- frozen diff + drift + tamper checks ----------------------------------------
  const frozen = await readArtifact(workdir, BUILD_DIFF_FILE);
  if (frozen === null) {
    return haltReview(workdir, state, null, presenter, "no frozen build diff (or it is empty); nothing to review — re-run `tackle build --redo`");
  }
  const pinnedDiff = buildState.diffHash;
  if (pinnedDiff !== undefined && sha256(frozen) !== pinnedDiff) {
    return haltReview(
      workdir,
      state,
      null,
      presenter,
      `${BUILD_DIFF_FILE} does not match the hash pinned at build approval; re-run \`tackle build --redo\``,
    );
  }
  const treeDiff = await captureWorkdirDiff(workdir, await resolveHead(workdir));
  if (treeDiff !== frozen) {
    return haltReview(workdir, state, null, presenter, "the working tree changed since build was approved; re-run `tackle build --redo`");
  }

  const policy = await loadPolicyConfig(workdir);
  return reviewLoop({ ...opts, state, policy, requirement, initialDiff: frozen });
}

interface LoopContext extends RunReviewOptions {
  state: WorkflowState;
  policy: PolicyConfig;
  requirement: { label: string; content: string };
  initialDiff: string;
}

/** Task 7 scope: one review round; blocking findings escalate straight to the gate. */
async function reviewLoop(ctx: LoopContext): Promise<PhaseOutcome> {
  const { presenter, state, workdir } = ctx;
  const rounds: RoundRecord[] = [];
  const currentDiff = ctx.initialDiff;

  const reviewed = await runReviewerTurn(ctx, currentDiff, rounds.length + 1);
  if ("halt" in reviewed) return reviewed.halt;
  const { result, verdict } = reviewed;
  rounds.push({ round: rounds.length + 1, verdict });

  const blocking = blockingFindings(verdict);
  const escalation =
    blocking.length === 0
      ? undefined
      : `${blocking.length} unresolved blocking finding(s); approving commits anyway, rejecting discards the review.`;
  await writeFile(join(workdir, SPINE.review.artifact), renderReviewMd(rounds, escalation));

  state.phases.review = {
    status: "awaiting_approval",
    lastTurn: toTurnRecord(result),
    reviewedDiffHash: sha256(currentDiff),
  };
  await writeWorkflowState(workdir, state);
  return presentReviewGateAndCommit(workdir, state, presenter, escalation);
}

/** One reviewer turn under the deterministic-retry policy, with purity + billing + verdict gates. */
async function runReviewerTurn(
  ctx: LoopContext,
  currentDiff: string,
  round: number,
): Promise<{ result: TurnResult; verdict: Verdict } | { halt: PhaseOutcome }> {
  const { presenter, policy, state, workdir } = ctx;
  let lastTurn: TurnResult | null = null;
  let retryNote: string | undefined;
  for (let attempt = 0; attempt <= policy.deterministicRetries; attempt++) {
    const prompt =
      buildReviewPrompt({ diff: currentDiff, requirement: ctx.requirement }) +
      (retryNote === undefined ? "" : `\n\n## Previous attempt\n\n${retryNote}`);
    const result = await ctx.reviewer.run({
      prompt,
      workdir,
      effort: ctx.effort ?? "medium",
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    lastTurn = result;

    const billingHalt = billingHaltMessage(result.usage.billingType);
    if (billingHalt !== null) return { halt: await haltReview(workdir, state, result, presenter, billingHalt) };
    if (result.workdirDiff !== currentDiff) {
      return {
        halt: await haltReview(
          workdir,
          state,
          result,
          presenter,
          "reviewer modified the working tree; inspect `git status` and clean up before re-running `tackle review`",
        ),
      };
    }
    if (result.status !== "completed") {
      retryNote = `The previous attempt ended with status "${result.status}" before finishing. Start over.`;
      continue;
    }
    const verdict = parseVerdict(result.summary);
    if (verdict === null) {
      retryNote = "The previous attempt did not end with a parseable fenced json verdict block. You must end with exactly one.";
      continue;
    }
    return { result, verdict };
  }
  return {
    halt: await haltReview(
      workdir,
      state,
      lastTurn,
      presenter,
      `review round ${round} produced no usable verdict after ${policy.deterministicRetries + 1} attempt(s)`,
    ),
  };
}
