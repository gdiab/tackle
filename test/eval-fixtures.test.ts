import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, listFixtures, loadManifest } from "../src/evals/manifest.js";

describe("committed fixtures", () => {
  it("every fixture in the repo has a valid manifest", async () => {
    const names = await listFixtures(process.cwd());
    expect(names).toEqual(["create-file", "edit-file", "error-normalization", "passing-test"]);
    for (const name of names) {
      const manifest = await loadManifest(join(process.cwd(), FIXTURES_DIR, name));
      expect(manifest.name).toBe(name);
      expect(manifest.expectations.length).toBeGreaterThan(0);
    }
  });
});
