import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFixtures, loadManifest } from "../src/evals/manifest.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("loadManifest", () => {
  it("loads and validates a full manifest", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "create-file", {
      manifest: manifestFor("create-file", {
        expectations: [
          { kind: "status", equals: "completed" },
          { kind: "billing", equals: "subscription" },
          { kind: "fileExists", path: "hello.txt" },
          { kind: "fileContains", path: "hello.txt", text: "hello", exact: true },
          { kind: "diffTouchesOnly", globs: ["hello.txt"] },
          { kind: "commandSucceeds", command: "true" },
        ],
      }),
    });
    const manifest = await loadManifest(dir);
    expect(manifest.name).toBe("create-file");
    expect(manifest.expectations).toHaveLength(6);
  });

  it("rejects an unknown expectation kind", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", {
      manifest: manifestFor("f", { expectations: [{ kind: "vibes", equals: "good" }] }),
    });
    await expect(loadManifest(dir)).rejects.toThrow(/unknown expectation kind "vibes"/);
  });

  it("rejects a status expectation outside the closed enum", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "f", {
      manifest: manifestFor("f", { expectations: [{ kind: "status", equals: "great" }] }),
    });
    await expect(loadManifest(dir)).rejects.toThrow(/equals must be one of/);
  });

  it("rejects a manifest whose name does not match its directory", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "actual", { manifest: manifestFor("other") });
    await expect(loadManifest(dir)).rejects.toThrow(/does not match directory name "actual"/);
  });

  it("rejects a missing manifest, invalid JSON, bad effort, and bad timeout", async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, "evals", "fixtures", "empty"), { recursive: true });
    await expect(loadManifest(join(workdir, "evals", "fixtures", "empty"))).rejects.toThrow(/missing manifest.json/);

    const bad1 = await makeFixture(workdir, "bad1", { manifest: manifestFor("bad1", { effort: "ultra" }) });
    await expect(loadManifest(bad1)).rejects.toThrow(/"effort" must be one of/);

    const bad2 = await makeFixture(workdir, "bad2", { manifest: manifestFor("bad2", { timeoutSeconds: 0 }) });
    await expect(loadManifest(bad2)).rejects.toThrow(/"timeoutSeconds" must be a positive number/);

    const bad3 = await makeFixture(workdir, "bad3", { manifest: manifestFor("bad3", { expectations: [] }) });
    await expect(loadManifest(bad3)).rejects.toThrow(/"expectations" must be a non-empty array/);
  });
});

describe("listFixtures", () => {
  it("returns sorted fixture names, skipping non-fixture entries", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "zeta", { manifest: manifestFor("zeta") });
    await makeFixture(workdir, "alpha", { manifest: manifestFor("alpha") });
    await mkdir(join(workdir, "evals", "fixtures", "no-manifest"), { recursive: true });
    expect(await listFixtures(workdir)).toEqual(["alpha", "zeta"]);
  });

  it("returns [] when evals/fixtures does not exist", async () => {
    expect(await listFixtures(await tempWorkdir())).toEqual([]);
  });
});
