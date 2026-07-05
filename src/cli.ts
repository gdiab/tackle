#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { ClaudeAdapter } from "./adapter/claude/index.js";
import { CodexAdapter } from "./adapter/codex/index.js";
import type { Adapter, Effort } from "./adapter/types.js";
import { listFixtures } from "./evals/manifest.js";
import { readResult } from "./evals/results.js";
import { checkFixture, runFixture } from "./evals/runner.js";
import { deriveState } from "./evals/state.js";
import { buildMap } from "./map/builder.js";
import { createVitestCoverageRunner } from "./map/coverage.js";
import { describeMap, testsFor } from "./map/query.js";
import { readTestMap, TEST_MAP_FILE, writeTestMap } from "./map/store.js";
import type { TestMapFile } from "./map/types.js";
import { runPhase } from "./workflow/phase.js";
import type { Presenter } from "./workflow/presenter.js";
import { TerminalPresenter } from "./workflow/presenter.js";
import { runReviewPhase } from "./workflow/review.js";
import { readWorkflowState } from "./workflow/state.js";
import { PHASE_ORDER, SPINE } from "./workflow/spine.js";
import type { PhaseName } from "./workflow/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

function parseTimeout(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("timeout must be a positive number");
  return n;
}

function withTurnOptions(cmd: Command): Command {
  return cmd
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .addOption(new Option("--effort <band>", "effort band").choices(["low", "medium", "high"]).default("medium"))
    .option("--model <model>", "model override (default: backend default)")
    .option("--timeout <seconds>", "turn timeout in seconds", parseTimeout);
}

interface PhaseCliOptions {
  cwd: string;
  effort: Effort;
  model?: string;
  timeout?: number;
  fresh?: boolean;
  redo?: boolean;
  skipSpecs?: boolean;
  trivial?: boolean;
}

function registerMapCommands(program: Command, writeOut: (s: string) => void): void {
  const map = program.command("map").description("Source-to-test dependency map (TDAD)");

  map
    .command("build")
    .description(`Build or refresh ${TEST_MAP_FILE} from the import graph + per-test coverage`)
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("--no-coverage", "skip per-test coverage runs (static import graph only)")
    .action(async (options: { cwd: string; coverage: boolean }) => {
      let previous: TestMapFile | null;
      try {
        previous = await readTestMap(options.cwd);
      } catch {
        writeOut("warning: existing test map is unreadable; rebuilding from scratch\n");
        previous = null;
      }
      const runner = options.coverage ? createVitestCoverageRunner(options.cwd) : null;
      if (options.coverage && runner === null) {
        writeOut("warning: vitest not found from the working directory; building a static-only map\n");
      }
      const built = await buildMap({
        workdir: options.cwd,
        runner,
        previous,
        log: (message) => writeOut(`${message}\n`),
      });
      await writeTestMap(options.cwd, built);
      const status = describeMap(built);
      writeOut(
        `${TEST_MAP_FILE}: ${status.testCount} test file(s) -> ${status.sourceCount} source file(s) (${status.mode})\n`,
      );
      for (const testFile of status.coverageFailures) writeOut(`coverage failed: ${testFile}\n`);
    });

  map
    .command("query")
    .description("List the tests that exercise a source file")
    .argument("<file>", "source file (repo-relative or absolute)")
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (file: string, options: { cwd: string }) => {
      const result = await testsFor(options.cwd, file);
      if (result.kind === "no-map") {
        writeOut("no test map; run `tackle map build` first\n");
        process.exitCode = 1;
        return;
      }
      if (result.kind === "unmapped") {
        writeOut(`unmapped: no known test exercises ${file} — write the test first\n`);
        return;
      }
      for (const edge of result.tests) writeOut(`${edge.test} (${edge.method})\n`);
    });

  map
    .command("status")
    .description("Show test-map freshness and coverage failures")
    .option("--cwd <dir>", "working directory", process.cwd())
    .action(async (options: { cwd: string }) => {
      const current = await readTestMap(options.cwd);
      if (current === null) {
        writeOut("no test map; run `tackle map build` first\n");
        process.exitCode = 1;
        return;
      }
      const status = describeMap(current);
      writeOut(`built ${status.builtAt} (${status.mode})\n`);
      writeOut(`${status.testCount} test file(s) -> ${status.sourceCount} source file(s)\n`);
      for (const testFile of status.coverageFailures) writeOut(`coverage failed: ${testFile}\n`);
    });
}

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
        if (report.debugWorkdir !== undefined) writeOut(`  turn workdir kept: ${report.debugWorkdir}\n`);
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
        writeOut(`${name}: ${report.state === "flaky" ? "flaky (warning — not blocking)" : report.state}\n`);
        if (report.state === "failing") process.exitCode = 1;
      }
    });
}

export function buildProgram(
  opts: {
    adapter?: Adapter;
    reviewerAdapter?: Adapter;
    presenter?: Presenter;
    writeOut?: (s: string) => void;
  } = {},
): Command {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);

  withTurnOptions(
    program
      .command("turn")
      .description("Run a single turn through an adapter and print the TurnResult")
      .argument("<prompt>", "the prompt for the turn"),
  ).action(async (prompt: string, options: PhaseCliOptions) => {
    const adapter = opts.adapter ?? new CodexAdapter();
    const result = await adapter.run({
      prompt,
      workdir: options.cwd,
      effort: options.effort,
      model: options.model,
      timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
    });
    writeOut(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "completed") process.exitCode = 1;
  });

  async function executePhase(
    phase: PhaseName,
    request: string | undefined,
    options: PhaseCliOptions,
  ): Promise<void> {
    const enteringHere =
      phase === "specs" || options.skipSpecs === true || options.trivial === true;
    if (enteringHere && phase !== "specs" && request === undefined) {
      throw new InvalidArgumentError(`starting a workflow at ${phase} requires a request argument`);
    }
    const adapter = opts.adapter ?? new CodexAdapter();
    const presenter = opts.presenter ?? new TerminalPresenter();
    const outcome = await runPhase({
      phase,
      workdir: options.cwd,
      adapter,
      presenter,
      canEnter: enteringHere,
      ...(request === undefined ? {} : { request }),
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      ...(options.redo === undefined ? {} : { redo: options.redo }),
      effort: options.effort,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
    });
    if (outcome !== "approved") process.exitCode = 1;
  }

  withTurnOptions(
    program
      .command("specs")
      .description("Write .tackle/specs.md from a request (workflow entry)")
      .argument("<request>", "what to build"),
  )
    .option("--fresh", "discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string, options: PhaseCliOptions) => executePhase("specs", request, options));

  withTurnOptions(
    program
      .command("plan")
      .description("Write .tackle/plan.md from the approved specs")
      .argument("[request]", "amended or entry request"),
  )
    .option("--skip-specs", "start the workflow at plan (bug fixes)")
    .option("--fresh", "with --skip-specs: discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string | undefined, options: PhaseCliOptions) =>
      executePhase("plan", request, options),
    );

  withTurnOptions(
    program
      .command("build")
      .description("Implement the approved plan; freeze the diff to .tackle/build.diff")
      .argument("[request]", "amended or entry request"),
  )
    .option("--trivial", "start the workflow at build (trivial changes)")
    .option("--fresh", "with --trivial: discard any in-progress workflow and start over")
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (request: string | undefined, options: PhaseCliOptions) =>
      executePhase("build", request, options),
    );

  withTurnOptions(
    program
      .command("review")
      .description("Cross-model review of the frozen build diff; approval commits it"),
  )
    .option("--redo", "re-run review even if it already has a verdict")
    .action(async (options: PhaseCliOptions) => {
      const outcome = await runReviewPhase({
        workdir: options.cwd,
        reviewer: opts.reviewerAdapter ?? new ClaudeAdapter(),
        author: opts.adapter ?? new CodexAdapter(),
        presenter: opts.presenter ?? new TerminalPresenter(),
        ...(options.redo === undefined ? {} : { redo: options.redo }),
        effort: options.effort,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
      });
      if (outcome !== "approved") process.exitCode = 1;
    });

  withTurnOptions(
    program.command("pr").description("Write the PR body to .tackle/pr.md from the build artifacts"),
  )
    .option("--redo", "re-run this phase even if it already has an artifact")
    .action(async (options: PhaseCliOptions) => executePhase("pr", undefined, options));

  program
    .command("status")
    .description("Show the workflow state")
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .action(async (options: { cwd: string }) => {
      const state = await readWorkflowState(options.cwd);
      if (state === null) {
        writeOut("no workflow in progress\n");
        return;
      }
      writeOut(`request: ${state.request}\nentry: ${state.entry}\n`);
      for (const phase of PHASE_ORDER) {
        if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(state.entry)) continue;
        const status = state.phases[phase]?.status ?? "pending";
        writeOut(`${phase.padEnd(6)} ${status.padEnd(20)} ${SPINE[phase].artifact}\n`);
      }
      const commit = state.phases.review?.commitSha;
      if (commit !== undefined) writeOut(`commit ${commit.slice(0, 10)}\n`);
    });

  registerMapCommands(program, writeOut);
  registerEvalCommands(program, writeOut, () => opts.adapter ?? new CodexAdapter());

  return program;
}

// argv[1] can be a symlink (e.g. a node_modules/.bin shim from `pnpm link`);
// realpath it before comparing so this still resolves to true through a link.
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
