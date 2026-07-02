import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildAdapterEnv } from "../env.js";
import { runCommand } from "../exec.js";
import { captureWorkdirDiff, resolveHead } from "../diff.js";
import type { Adapter, TurnRequest, TurnResult, TokenUsage } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { buildPrintCommand } from "./command.js";
import { parseStreamLine } from "./stream.js";
import { detectBillingType } from "./billing.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export class CodexAdapter implements Adapter {
  readonly name = "codex";
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly authPathOverride?: string;

  constructor(opts: { baseEnv?: Record<string, string | undefined>; authPath?: string } = {}) {
    this.baseEnv = opts.baseEnv ?? process.env;
    this.authPathOverride = opts.authPath;
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const env = buildAdapterEnv({ base: this.baseEnv, allow: ["PATH", "HOME"] });
    // codex itself resolves ~/.codex from this same allowlist-built env.HOME;
    // deriving the default authPath from it (rather than the process's own
    // homedir()) keeps the billing check pointed at the subprocess's actual home.
    const authPath = this.authPathOverride ?? join(env.HOME ?? homedir(), ".codex", "auth.json");
    const billingType = await detectBillingType({ env, authPath });
    const baseRef = await resolveHead(req.workdir);
    const command = buildPrintCommand({
      prompt: req.prompt,
      effort: req.effort,
      model: req.model,
      resumeSessionId: req.resumeSessionId,
    });

    const rawLines: string[] = [];
    let sessionId: string | null = null;
    let summary = "";
    let usage: TokenUsage | null = null;
    let errored = false;

    const exec = await runCommand({
      cmd: command.cmd,
      args: command.args,
      stdin: command.stdin,
      cwd: req.workdir,
      env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onLine: (line) => {
        rawLines.push(line);
        const event = parseStreamLine(line);
        if (event === null) return;
        if (event.kind === "session") sessionId = event.sessionId;
        if (event.kind === "message") summary = event.text;
        if (event.kind === "usage") usage = event.usage;
        if (event.kind === "error") errored = true;
      },
    });

    // Capture the diff before writing the transcript file. captureWorkdirDiff
    // already excludes .tackle/ (harness state, not part of the turn's diff),
    // but the transcript is the durable artifact regardless — it must land on
    // disk even if diff capture fails, so defer any diff error until after.
    let workdirDiff = "";
    let diffError: unknown;
    try {
      workdirDiff = await captureWorkdirDiff(req.workdir, baseRef);
    } catch (err) {
      diffError = err;
    }

    const transcriptDir = join(req.workdir, ".tackle", "transcripts");
    await mkdir(transcriptDir, { recursive: true });
    const transcriptRef = join(
      transcriptDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-codex.jsonl`,
    );
    await writeFile(transcriptRef, rawLines.join("\n") + "\n");

    if (diffError !== undefined) throw diffError;

    let status: TurnResult["status"];
    if (exec.timedOut) status = "timeout";
    else if (errored || exec.exitCode !== 0) status = "tool_error";
    else if (usage !== null) status = "completed";
    else status = "tool_error";

    return {
      status,
      workdirDiff,
      transcriptRef,
      summary,
      sessionId,
      authorship: { adapter: this.name, model: req.model ?? null, effort: req.effort },
      usage: { tokens: usage ?? EMPTY_USAGE, billingType },
    };
  }
}
