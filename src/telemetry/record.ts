import type { Adapter, TurnRequest, TurnResult } from "../adapter/types.js";
import type { FileTouch } from "./diffstat.js";
import { parseDiffStats } from "./diffstat.js";
import type { TurnRecordV1 } from "./ledger.js";
import { appendTurnRecord } from "./ledger.js";

export interface RecordedRunOptions {
  /** Repo whose .tackle/telemetry ledger receives the record (the turn's target repo). */
  repoDir: string;
  /** "turn" | "phase:<name>" | "review:reviewer" | "review:fix" */
  context: string;
  /** Telemetry failures warn here and never fail the turn. Default: stderr. */
  warn?: (message: string) => void;
}

/**
 * The capture seam: times the call, runs the adapter, appends one ledger line,
 * returns the result unchanged. Call sites swap adapter.run(...) for this.
 */
export async function recordedRun(adapter: Adapter, req: TurnRequest, opts: RecordedRunOptions): Promise<TurnResult> {
  const startedAt = Date.now();
  const result = await adapter.run(req);
  const durationMs = Date.now() - startedAt;
  const warn = opts.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  let filesTouched: FileTouch[] = [];
  try {
    filesTouched = parseDiffStats(result.workdirDiff);
  } catch (err) {
    warn(`telemetry: could not derive file stats from the turn diff: ${err instanceof Error ? err.message : String(err)}`);
  }

  const record: TurnRecordV1 = {
    schema: "turn-record/v1",
    at: new Date(startedAt).toISOString(),
    context: opts.context,
    durationMs,
    status: result.status,
    billingType: result.usage.billingType,
    authorship: result.authorship,
    tokens: result.usage.tokens,
    filesTouched,
    sessionId: result.sessionId,
    transcriptRef: result.transcriptRef,
  };
  try {
    await appendTurnRecord(opts.repoDir, record);
  } catch (err) {
    warn(`telemetry: failed to append the turn record: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
