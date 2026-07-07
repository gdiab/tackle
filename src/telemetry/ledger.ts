import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Authorship, BillingType, TokenUsage, TurnStatus } from "../adapter/types.js";
import type { FileTouch } from "./diffstat.js";

export const TELEMETRY_DIR = ".tackle/telemetry";
export const TURNS_FILE = ".tackle/telemetry/turns.jsonl";

/** One real turn. Self-contained; no prompt or diff body — transcriptRef is the evidence pointer. */
export interface TurnRecordV1 {
  schema: "turn-record/v1";
  at: string; // ISO-8601, turn start
  context: string; // "turn" | "phase:<name>" | "review:reviewer" | "review:fix"
  durationMs: number;
  status: TurnStatus;
  billingType: BillingType;
  authorship: Authorship;
  tokens: TokenUsage;
  filesTouched: FileTouch[];
  sessionId: string | null;
  transcriptRef: string;
}

export async function appendTurnRecord(repoDir: string, record: TurnRecordV1): Promise<void> {
  await mkdir(join(repoDir, TELEMETRY_DIR), { recursive: true });
  await appendFile(join(repoDir, TURNS_FILE), JSON.stringify(record) + "\n");
}

export interface LedgerRead {
  records: TurnRecordV1[];
  malformed: number;
}

/** Forgiving reader: malformed lines are skipped and counted, never fatal. */
export async function readTurnRecords(repoDir: string): Promise<LedgerRead> {
  let raw: string;
  try {
    raw = await readFile(join(repoDir, TURNS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], malformed: 0 };
    throw err;
  }
  const records: TurnRecordV1[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== "turn-record/v1") {
      malformed += 1;
      continue;
    }
    records.push(parsed as TurnRecordV1);
  }
  return { records, malformed };
}
