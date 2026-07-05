import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, git, resolveHead } from "../src/adapter/diff.js";
import { applyRecordedDiff, materializeWorkdir } from "../src/evals/materialize.js";
import { makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

describe("materializeWorkdir", () => {
  it("copies the seed into a fresh committed git repo", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", {
      manifest: manifestFor("f"),
      seed: { "greeting.txt": "hello world\n", "src/deep.txt": "deep\n" },
    });
    const workdir = await materializeWorkdir(dir);
    expect(await readFile(join(workdir, "greeting.txt"), "utf8")).toBe("hello world\n");
    expect(await readFile(join(workdir, "src", "deep.txt"), "utf8")).toBe("deep\n");
    expect((await git(workdir, ["status", "--porcelain"])).trim()).toBe("");
    await expect(resolveHead(workdir)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("materializes a seedless fixture as an empty repo with one commit", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f") });
    const workdir = await materializeWorkdir(dir);
    await expect(resolveHead(workdir)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("applyRecordedDiff", () => {
  it("reconstructs new and modified files from a recorded workdirDiff", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f"), seed: { "greeting.txt": "hello world\n" } });

    // First materialization plays the "live turn": modify a seeded file, add a new one.
    const live = await materializeWorkdir(dir);
    const head = await resolveHead(live);
    await writeFile(join(live, "greeting.txt"), "hello tackle\n");
    await writeFile(join(live, "hello.txt"), "hello\n");
    const diff = await captureWorkdirDiff(live, head);
    expect(diff).not.toBe("");

    // Second materialization replays it.
    const replay = await materializeWorkdir(dir);
    await applyRecordedDiff(replay, diff);
    expect(await readFile(join(replay, "greeting.txt"), "utf8")).toBe("hello tackle\n");
    expect(await readFile(join(replay, "hello.txt"), "utf8")).toBe("hello\n");
  });

  it("is a no-op on an empty diff and throws on a non-applying diff", async () => {
    const base = await tempWorkdir();
    const dir = await makeFixture(base, "f", { manifest: manifestFor("f") });
    const workdir = await materializeWorkdir(dir);
    await expect(applyRecordedDiff(workdir, "")).resolves.toBeUndefined();
    await expect(applyRecordedDiff(workdir, "not a diff\n")).rejects.toThrow();
  });
});
