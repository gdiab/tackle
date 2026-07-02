import type { TokenUsage } from "../types.js";

export type CodexEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "error"; message: string }
  | { kind: "other"; raw: unknown };

export function normalizeUsage(raw: {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}): TokenUsage {
  const cached = raw.cached_input_tokens ?? 0;
  return {
    inputTokens: raw.input_tokens - cached,
    cacheReadInputTokens: cached,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
  };
}

export function parseStreamLine(line: string): CodexEvent | null {
  if (line.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // codex mixes human-readable notices into stdout
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as {
    type?: string;
    thread_id?: string;
    item?: { type?: string; text?: string };
    usage?: {
      input_tokens?: unknown;
      cached_input_tokens?: number;
      output_tokens?: unknown;
      reasoning_output_tokens?: number;
    };
    error?: { message?: string };
  };

  switch (event.type) {
    case "thread.started":
      return event.thread_id ? { kind: "session", sessionId: event.thread_id } : { kind: "other", raw: parsed };
    case "item.completed":
      return event.item?.type === "agent_message" && typeof event.item.text === "string"
        ? { kind: "message", text: event.item.text }
        : { kind: "other", raw: parsed };
    case "turn.completed": {
      const usage = event.usage;
      return usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? {
            kind: "usage",
            usage: normalizeUsage({
              input_tokens: usage.input_tokens,
              cached_input_tokens: usage.cached_input_tokens,
              output_tokens: usage.output_tokens,
              reasoning_output_tokens: usage.reasoning_output_tokens,
            }),
          }
        : { kind: "other", raw: parsed };
    }
    case "turn.failed":
      return { kind: "error", message: event.error?.message ?? "turn failed" };
    default:
      return { kind: "other", raw: parsed };
  }
}
