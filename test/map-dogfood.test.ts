import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMap } from "../src/map/builder.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Static-only on purpose: a coverage build here would recursively run this suite.
// Fixture repos under test/fixtures/ get discovered too; their alias imports don't
// resolve under the root tsconfig, which is fine — dogfood asserts root edges only.
describe("dogfood: tackle's own test map (static-only)", () => {
  it("maps this repo's tests to the sources they import", async () => {
    const map = await buildMap({ workdir: repoRoot, runner: null, previous: null });
    expect(map.mode).toBe("static-only");
    expect(map.sources["src/workflow/state.ts"]).toContain("test/workflow-state.test.ts");
    expect(map.sources["src/workflow/prompts.ts"]).toContain("test/prompts.test.ts");
    // Transitivity: tests reach adapter types through the helpers they import.
    expect(map.sources["src/adapter/types.ts"]).toContain("test/phase.test.ts");
    // The shared helper is itself a mapped source — changing it affects its importers.
    expect(map.sources["test/helpers/workflow.ts"]).toContain("test/phase.test.ts");
  });
});
