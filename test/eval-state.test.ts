import { describe, expect, it } from "vitest";
import { deriveState } from "../src/evals/state.js";

describe("deriveState", () => {
  it("is healthy when every run in the window passes", () => {
    expect(deriveState([true, true, true])).toBe("healthy");
    expect(deriveState([true])).toBe("healthy");
  });

  it("is failing when every run fails, including a single-run history", () => {
    expect(deriveState([false, false])).toBe("failing");
    expect(deriveState([false])).toBe("failing");
  });

  it("is flaky when the window mixes passes and failures", () => {
    expect(deriveState([true, false, true])).toBe("flaky");
  });

  it("throws on an empty window", () => {
    expect(() => deriveState([])).toThrow(/at least one graded run/);
  });
});
