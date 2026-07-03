import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_MAP_FILE } from "../src/map/store.js";
import { runPhase } from "../src/workflow/phase.js";
import { SPINE } from "../src/workflow/spine.js";
import { approveAll, capturingPresenter, scriptedAdapter, tempWorkdir, writesArtifact } from "./helpers/workflow.js";

const validMap = JSON.stringify({
  version: 1,
  builtAt: "2026-07-03T00:00:00.000Z",
  mode: "static-only",
  tests: { "test/a.test.ts": { hash: "h", sources: { "src/a.ts": "static" } } },
  sources: { "src/a.ts": ["test/a.test.ts"] },
});

async function runBuild(dir: string, presenter = approveAll) {
  const adapter = scriptedAdapter([writesArtifact(SPINE.build.artifact, "notes")]);
  const outcome = await runPhase({
    phase: "build",
    workdir: dir,
    adapter,
    presenter,
    canEnter: true,
    request: "do it",
  });
  return { outcome, prompt: adapter.prompts[0] ?? "" };
}

describe("build phase test-map wiring", () => {
  it("injects the map section when a map exists", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), validMap);
    const { outcome, prompt } = await runBuild(dir);
    expect(outcome).toBe("approved");
    expect(prompt).toContain("## Source-to-test map");
    expect(prompt).toContain(TEST_MAP_FILE);
  });

  it("omits the section when no map exists", async () => {
    const { outcome, prompt } = await runBuild(await tempWorkdir());
    expect(outcome).toBe("approved");
    expect(prompt).not.toContain("## Source-to-test map");
  });

  it("degrades with a warning when the map is corrupt", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), "not json");
    const presenter = capturingPresenter(true);
    const { outcome, prompt } = await runBuild(dir, presenter);
    expect(outcome).toBe("approved");
    expect(prompt).not.toContain("## Source-to-test map");
    expect(presenter.messages.some((m) => m.includes("test-map"))).toBe(true);
  });
});
