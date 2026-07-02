import type { Authorship, BillingType, TurnStatus } from "../adapter/types.js";

export type PhaseName = "specs" | "plan" | "build" | "pr";

// Absent from WorkflowState.phases = not started. "halted" = a gate budget was
// exhausted or the billing gate fired; re-runnable, kept for `tackle status`.
export type PhaseStatus = "needs_clarification" | "awaiting_approval" | "approved" | "halted";

export interface TurnRecord {
  status: TurnStatus;
  summary: string;
  authorship: Authorship;
  billingType: BillingType;
  transcriptRef: string;
  sessionId: string | null;
}

export interface PhaseState {
  status: PhaseStatus;
  lastTurn?: TurnRecord;
}

export interface WorkflowState {
  version: 1;
  request: string;
  entry: PhaseName;
  phases: Partial<Record<PhaseName, PhaseState>>;
}

// SPEC.md "Gate semantics": budgets are config, not constants. Only
// deterministicRetries is consumed by the spine; the other two are the review
// gate's budgets (tackle-483), defined here so they are config from day one.
export interface PolicyConfig {
  deterministicRetries: number;
  reviewLoopIterations: number;
  circuitBreakerThreshold: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  deterministicRetries: 1,
  reviewLoopIterations: 2,
  circuitBreakerThreshold: 2,
};
