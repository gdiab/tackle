import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(() => Buffer.from("aaaaaa", "hex")),
  };
});

const { transcriptFilename } = await import("../src/adapter/transcript.js");

describe("transcriptFilename", () => {
  it("deterministically produces distinct filenames for two calls at the same frozen timestamp, even with a colliding random suffix", () => {
    // Time is frozen AND randomBytes is mocked (module-level, above) to always
    // return the same bytes, simulating the same-millisecond same-random-suffix
    // case. Distinctness must now come from an in-process monotonic counter,
    // not chance -- so this is guaranteed, not merely probable.
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
