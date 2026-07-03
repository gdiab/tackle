import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureWorkdirDiff, resolveHead } from "../diff.js";
import { buildAdapterEnv } from "../env.js";
import { runCommand } from "../exec.js";
import type { Adapter, TurnRequest, TurnResult } from "../types.js";
import { EMPTY_USAGE } from "../types.js";
import { defaultCredentialsReader, detectBillingType } from "./billing.js";
import { buildPrintCommand } from "./command.js";
import { parseResultJson } from "./result.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export class ClaudeAdapter implements Adapter {
  readonly name = "claude-code";
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly readCredentials?: () => Promise<string | null>;

  constructor(
    opts: { baseEnv?: Record<string, string | undefined>; readCredentials?: () => Promise<string | null> } = {},
  ) {
    this.baseEnv = opts.baseEnv ?? process.env;
    this.readCredentials = opts.readCredentials;
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const env = buildAdapterEnv({ base: this.baseEnv, allow: ["PATH", "HOME"] });
    const home = env.HOME ?? homedir();
    const billingType = await detectBillingType({
      env,
      readCredentials: this.readCredentials ?? defaultCredentialsReader({ home }),
    });
    const baseRef = await resolveHead(req.workdir);
    const command = buildPrintCommand({
      prompt: req.prompt,
      effort: req.effort,
      ...(req.model === undefined ? {} : { model: req.model }),
    });

    const exec = await runCommand({
      cmd: command.cmd,
      args: command.args,
      stdin: command.stdin,
      cwd: req.workdir,
      env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const parsed = parseResultJson(exec.stdout);

    // Same ordering rationale as CodexAdapter: transcript must land even if
    // diff capture fails, so defer any diff error until after the write.
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
      `${new Date().toISOString().replace(/[:.]/g, "-")}-claude.json`,
    );
    await writeFile(transcriptRef, exec.stdout);

    if (diffError !== undefined) throw diffError;

    let status: TurnResult["status"];
    if (exec.timedOut) status = "timeout";
    else if (exec.exitCode !== 0) status = "tool_error";
    else status = parsed.status;

    return {
      status,
      workdirDiff,
      transcriptRef,
      summary: parsed.summary,
      sessionId: parsed.sessionId,
      authorship: { adapter: this.name, model: req.model ?? null, effort: req.effort },
      usage: { tokens: parsed.usage ?? EMPTY_USAGE, billingType },
    };
  }
}
