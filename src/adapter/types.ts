export type Effort = "low" | "medium" | "high";
export type TurnStatus = "completed" | "refused" | "timeout" | "tool_error" | "budget_exceeded";
export type BillingType = "subscription" | "metered" | "unknown";

export interface TokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface Authorship {
  adapter: string;
  model: string | null; // null = backend default model
  effort: Effort;
  stackProfile?: string;
}

export interface TurnResult {
  status: TurnStatus;
  workdirDiff: string;
  transcriptRef: string;
  summary: string;
  sessionId: string | null;
  authorship: Authorship;
  usage: { tokens: TokenUsage; billingType: BillingType };
}

export interface TurnRequest {
  prompt: string;
  workdir: string;
  effort: Effort;
  model?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
}

export interface Adapter {
  readonly name: string;
  run(req: TurnRequest): Promise<TurnResult>;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
