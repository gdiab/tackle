/**
 * Quarantine state derived from the graded trailing window — never curated.
 * healthy: every run passes. failing: every run fails (real signal; human
 * decision). flaky: both present — visible, tracked, never blocking.
 */
export type FixtureState = "healthy" | "failing" | "flaky";

export function deriveState(passes: boolean[]): FixtureState {
  if (passes.length === 0) throw new Error("deriveState requires at least one graded run");
  if (passes.every((p) => p)) return "healthy";
  if (passes.every((p) => !p)) return "failing";
  return "flaky";
}
