import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DECISIONS_FILE = ".tackle/decisions.md";

export type DecisionSource = "human" | "workflow";

export interface DecisionEntry {
  id: number;
  date: string; // YYYY-MM-DD
  title: string;
  decision: string;
  rejected: string[];
  source: DecisionSource;
}

export interface NewDecision {
  title: string;
  decision: string;
  rejected: string[];
  source: DecisionSource;
}

const HEADING = /^## D-(\d+) — (\d{4}-\d{2}-\d{2}) — (.+)$/;
const DECISION_PREFIX = "- **Decision:** ";
const REJECTED_PREFIX = "- **Rejected:** ";
const SOURCE_PREFIX = "- **Source:** ";

export function formatDecisionId(id: number): string {
  return `D-${String(id).padStart(3, "0")}`;
}

/**
 * The markdown IS the store. Anything that would make ID assignment a guess
 * (bad heading, missing Decision/Source, unknown source) is a hard error.
 */
export function parseDecisions(content: string): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  let current: { id: number; date: string; title: string; decision: string | null; rejected: string[]; source: DecisionSource | null } | null = null;

  const finalize = (): void => {
    if (current === null) return;
    if (current.decision === null || current.source === null) {
      throw new Error(
        `${DECISIONS_FILE}: ${formatDecisionId(current.id)} is missing its **Decision:** or **Source:** line; fix the file by hand`,
      );
    }
    entries.push({ ...current, decision: current.decision, source: current.source });
  };

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      finalize();
      const m = HEADING.exec(line);
      const [, id, date, title] = m ?? [];
      if (id === undefined || date === undefined || title === undefined) {
        throw new Error(
          `${DECISIONS_FILE}: unparseable heading "${line}"; expected "## D-NNN — YYYY-MM-DD — title" — fix the file by hand`,
        );
      }
      current = { id: Number(id), date, title, decision: null, rejected: [], source: null };
      continue;
    }
    if (current === null) continue; // preamble before the first entry
    if (line.startsWith(DECISION_PREFIX)) {
      current.decision = line.slice(DECISION_PREFIX.length);
    } else if (line.startsWith(REJECTED_PREFIX)) {
      current.rejected.push(line.slice(REJECTED_PREFIX.length));
    } else if (line.startsWith(SOURCE_PREFIX)) {
      const source = line.slice(SOURCE_PREFIX.length).trim();
      if (source !== "human" && source !== "workflow") {
        throw new Error(`${DECISIONS_FILE}: ${formatDecisionId(current.id)} has source "${source}"; expected human or workflow`);
      }
      current.source = source;
    }
  }
  finalize();
  return entries;
}

export async function readDecisions(repoDir: string): Promise<DecisionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoDir, DECISIONS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseDecisions(raw);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Append-only by design: no edit, no delete. Returns the assigned ID (e.g. "D-004"). */
export async function appendDecision(
  repoDir: string,
  entry: NewDecision,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<string> {
  const title = oneLine(entry.title);
  if (title.length === 0) throw new Error("decision title must not be blank");

  const target = join(repoDir, DECISIONS_FILE);
  let existing: string;
  try {
    existing = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "# Decisions\n";
  }
  const parsed = parseDecisions(existing); // throws before any write on a corrupt file
  const nextId = parsed.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  const id = formatDecisionId(nextId);

  const rejectedLines = entry.rejected.map((r) => `${REJECTED_PREFIX}${oneLine(r)}\n`).join("");
  const block =
    `\n## ${id} — ${date} — ${title}\n\n` +
    `${DECISION_PREFIX}${oneLine(entry.decision)}\n` +
    rejectedLines +
    `${SOURCE_PREFIX}${entry.source}\n`;

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, base + block);
  await rename(tmp, target);
  return id;
}
