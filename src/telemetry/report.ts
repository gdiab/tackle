import type { TokenUsage } from "../adapter/types.js";
import type { TurnRecordV1 } from "./ledger.js";
import { costUsd, findPricing, PRICING_AS_OF, resolveModelLabel } from "./pricing.js";

export const CHURN_TOP = 20;

export interface ChurnRow {
  path: string;
  touches: number;
  insertions: number;
  deletions: number;
}

export interface CostRow {
  model: string;
  tokens: TokenUsage;
  usd: number;
}

export interface TelemetryReport {
  schema: "telemetry-report/v1";
  turns: number;
  byContext: Record<string, { turns: number; byStatus: Record<string, number> }>;
  tokens: { total: TokenUsage; byModel: Record<string, TokenUsage> };
  billing: Record<string, { turns: number; tokens: TokenUsage }>;
  cost: {
    asOf: string;
    priced: CostRow[];
    /** metered-equivalent: what the window's tokens would cost on the API */
    totalUsd: number;
    /** the subset of totalUsd from turns that actually billed metered */
    actualMeteredUsd: number;
    /** tokens excluded from totalUsd because no pricing row matched — fail loud */
    unpriced: Array<{ model: string; tokens: TokenUsage }>;
  };
  churn: { files: ChurnRow[]; multiTouch: number; totalFiles: number };
}

function zeroTokens(): TokenUsage {
  return { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

function addTokens(into: TokenUsage, t: TokenUsage): void {
  into.inputTokens += t.inputTokens;
  into.cacheReadInputTokens += t.cacheReadInputTokens;
  into.outputTokens += t.outputTokens;
  into.reasoningOutputTokens += t.reasoningOutputTokens;
}

/** Every figure computed fresh from the records; nothing persisted. */
export function computeTelemetryReport(records: TurnRecordV1[]): TelemetryReport {
  const byContext: Record<string, { turns: number; byStatus: Record<string, number> }> = {};
  const total = zeroTokens();
  const byModel: Record<string, TokenUsage> = {};
  const billing: Record<string, { turns: number; tokens: TokenUsage }> = {};
  const churnMap = new Map<string, ChurnRow>();
  let actualMeteredUsd = 0;

  for (const r of records) {
    const ctx = (byContext[r.context] ??= { turns: 0, byStatus: {} });
    ctx.turns += 1;
    ctx.byStatus[r.status] = (ctx.byStatus[r.status] ?? 0) + 1;

    addTokens(total, r.tokens);
    const model = resolveModelLabel(r.authorship);
    addTokens((byModel[model] ??= zeroTokens()), r.tokens);

    const bill = (billing[r.billingType] ??= { turns: 0, tokens: zeroTokens() });
    bill.turns += 1;
    addTokens(bill.tokens, r.tokens);

    if (r.billingType === "metered") {
      const pricing = findPricing(model);
      if (pricing !== null) actualMeteredUsd += costUsd(r.tokens, pricing);
    }

    for (const f of r.filesTouched) {
      const row = churnMap.get(f.path) ?? { path: f.path, touches: 0, insertions: 0, deletions: 0 };
      row.touches += 1;
      row.insertions += f.insertions;
      row.deletions += f.deletions;
      churnMap.set(f.path, row);
    }
  }

  const priced: CostRow[] = [];
  const unpriced: Array<{ model: string; tokens: TokenUsage }> = [];
  let totalUsd = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    const pricing = findPricing(model);
    if (pricing === null) {
      unpriced.push({ model, tokens });
      continue;
    }
    const usd = costUsd(tokens, pricing);
    priced.push({ model, tokens, usd });
    totalUsd += usd;
  }
  priced.sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));

  const allFiles = [...churnMap.values()].sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path));

  return {
    schema: "telemetry-report/v1",
    turns: records.length,
    byContext,
    tokens: { total, byModel },
    billing,
    cost: { asOf: PRICING_AS_OF, priced, totalUsd, actualMeteredUsd, unpriced },
    churn: {
      files: allFiles.slice(0, CHURN_TOP),
      multiTouch: allFiles.filter((f) => f.touches > 1).length,
      totalFiles: allFiles.length,
    },
  };
}

function fmtTokens(t: TokenUsage): string {
  return `in ${t.inputTokens}, cache ${t.cacheReadInputTokens}, out ${t.outputTokens} (reasoning ${t.reasoningOutputTokens})`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function renderTelemetryReport(report: TelemetryReport, opts: { malformed: number } = { malformed: 0 }): string {
  const lines: string[] = [];

  lines.push(`turns: ${report.turns}`);
  for (const [context, s] of Object.entries(report.byContext).sort(([a], [b]) => a.localeCompare(b))) {
    const statuses = Object.entries(s.byStatus)
      .map(([status, n]) => `${status} ${n}`)
      .join(", ");
    lines.push(`  ${context.padEnd(18)} ${s.turns} (${statuses})`);
  }

  lines.push("", `tokens: ${fmtTokens(report.tokens.total)}`);
  for (const [model, t] of Object.entries(report.tokens.byModel).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${model.padEnd(28)} ${fmtTokens(t)}`);
  }

  lines.push("", "billing:");
  for (const [type, row] of Object.entries(report.billing).sort(([a], [b]) => a.localeCompare(b))) {
    const alert = type === "metered" ? "   <-- metered turns present (subscription gate!)" : "";
    lines.push(`  ${type.padEnd(14)} ${row.turns} turn(s), ${fmtTokens(row.tokens)}${alert}`);
  }

  lines.push("", `metered-equivalent cost (pricing as of ${report.cost.asOf}):`);
  for (const row of report.cost.priced) lines.push(`  ${row.model.padEnd(28)} ${fmtUsd(row.usd)}`);
  const actual =
    report.cost.actualMeteredUsd > 0 ? ` (of which ${fmtUsd(report.cost.actualMeteredUsd)} actually billed metered)` : "";
  lines.push(`  ${"total".padEnd(28)} ${fmtUsd(report.cost.totalUsd)}${actual}`);
  for (const u of report.cost.unpriced) {
    lines.push(`  UNPRICED ${u.model}: ${fmtTokens(u.tokens)} — not in the total; add a row to src/telemetry/pricing.ts`);
  }

  const capNote = report.churn.totalFiles > CHURN_TOP ? ` (top ${CHURN_TOP} shown)` : "";
  lines.push("", `churn: ${report.churn.totalFiles} file(s) touched, ${report.churn.multiTouch} touched more than once${capNote}`);
  for (const f of report.churn.files) lines.push(`  ${f.path}  x${f.touches}  +${f.insertions} -${f.deletions}`);

  if (opts.malformed > 0) lines.push("", `warning: skipped ${opts.malformed} malformed ledger line(s)`);
  return lines.join("\n") + "\n";
}
