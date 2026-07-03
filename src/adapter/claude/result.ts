import type { TokenUsage, TurnStatus } from "../types.js";

export interface ClaudeResult {
  status: TurnStatus;
  summary: string;
  sessionId: string | null;
  usage: TokenUsage | null;
}

const FAILED: ClaudeResult = { status: "tool_error", summary: "", sessionId: null, usage: null };

/** claude -p --output-format json prints exactly one JSON object on stdout. */
export function parseResultJson(stdout: string): ClaudeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return FAILED;
  }
  if (typeof raw !== "object" || raw === null) return FAILED;
  const r = raw as {
    type?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; output_tokens?: unknown };
  };
  if (r.type !== "result") return FAILED;

  const usage: TokenUsage | null =
    typeof r.usage === "object" && r.usage !== null
      ? {
          inputTokens: typeof r.usage.input_tokens === "number" ? r.usage.input_tokens : 0,
          cacheReadInputTokens:
            typeof r.usage.cache_read_input_tokens === "number" ? r.usage.cache_read_input_tokens : 0,
          outputTokens: typeof r.usage.output_tokens === "number" ? r.usage.output_tokens : 0,
          reasoningOutputTokens: 0,
        }
      : null;

  return {
    status: r.is_error === false && r.subtype === "success" ? "completed" : "tool_error",
    summary: typeof r.result === "string" ? r.result : "",
    sessionId: typeof r.session_id === "string" ? r.session_id : null,
    usage,
  };
}
