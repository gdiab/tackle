import { describe, expect, it } from "vitest";
import { canonicalJson, computeFingerprint } from "../src/evals/fingerprint.js";
import { loadManifest } from "../src/evals/manifest.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

async function fingerprintOf(name: string, overrides: Record<string, unknown>, seed?: Record<string, string>) {
  const workdir = await tempWorkdir();
  const dir = await makeFixture(workdir, name, { manifest: manifestFor(name, overrides), ...(seed === undefined ? {} : { seed }) });
  return computeFingerprint({ fixtureDir: dir, manifest: await loadManifest(dir), adapterName: "codex" });
}

describe("computeFingerprint", () => {
  it("is stable across expectation and description changes", async () => {
    const a = await fingerprintOf("f", { description: "one" });
    const b = await fingerprintOf("f", {
      description: "two",
      expectations: [{ kind: "fileExists", path: "x" }],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when prompt, effort, timeout, adapter, or seed content changes", async () => {
    const base = await fingerprintOf("f", {}, { "a.txt": "1" });
    expect(await fingerprintOf("f", { prompt: "different" }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", { effort: "high" }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", { timeoutSeconds: 61 }, { "a.txt": "1" })).not.toBe(base);
    expect(await fingerprintOf("f", {}, { "a.txt": "2" })).not.toBe(base);
    expect(await fingerprintOf("f", {}, { "b.txt": "1" })).not.toBe(base);
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", { manifest: manifestFor("f"), seed: { "a.txt": "1" } });
    const otherAdapter = await computeFingerprint({ fixtureDir: dir, manifest: await loadManifest(dir), adapterName: "claude" });
    expect(otherAdapter).not.toBe(base);
  });

  it("handles a seedless fixture and nested seed paths", async () => {
    const seedless = await fingerprintOf("f", {});
    expect(seedless).toMatch(/^sha256:/);
    const nested = await fingerprintOf("f", {}, { "src/deep/a.txt": "1" });
    expect(nested).not.toBe(seedless);
  });
});
