export interface Finding {
  severity: "blocking" | "note";
  file: string;
  line?: number;
  summary: string;
  detail?: string;
}

export interface Verdict {
  verdict: "clean" | "findings";
  findings: Finding[];
}

/** Only blocking findings drive the fix loop; notes are recorded, never gating. */
export function blockingFindings(v: Verdict): Finding[] {
  return v.findings.filter((f) => f.severity === "blocking");
}

/**
 * Extract the LAST fenced ```json block — the prompt instructs the reviewer to
 * end with it, and earlier blocks may be the reviewer quoting the format back.
 * null = the gate could not read its measurement; the caller fails closed.
 */
export function parseVerdict(text: string): Verdict | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const verdict = (raw as { verdict?: unknown }).verdict;
  if (verdict !== "clean" && verdict !== "findings") return null;
  const findingsValue = (raw as { findings?: unknown }).findings;
  const rawFindings = findingsValue === undefined ? [] : findingsValue;
  if (!Array.isArray(rawFindings)) return null;

  const findings: Finding[] = [];
  for (const f of rawFindings) {
    if (typeof f !== "object" || f === null) return null;
    const { severity, file, line, summary, detail } = f as Record<string, unknown>;
    if (severity !== "blocking" && severity !== "note") return null;
    if (typeof file !== "string" || typeof summary !== "string") return null;
    findings.push({
      severity,
      file,
      summary,
      ...(typeof line === "number" ? { line } : {}),
      ...(typeof detail === "string" ? { detail } : {}),
    });
  }
  return { verdict, findings };
}
