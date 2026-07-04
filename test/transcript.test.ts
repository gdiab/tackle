import { describe, expect, it, vi } from "vitest";
import { transcriptFilename } from "../src/adapter/transcript.js";

describe("transcriptFilename", () => {
  it("produces distinct filenames for two calls at the same frozen timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const a = transcriptFilename("codex", "jsonl");
      const b = transcriptFilename("codex", "jsonl");
      expect(a).not.toBe(b);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the adapter name and extension", () => {
    const name = transcriptFilename("claude", "json");
    expect(name).toMatch(/-claude\.json$/);
  });
});
