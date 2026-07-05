import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readResult } from "../src/evals/results.js";
import { checkFixture, runFixture } from "../src/evals/runner.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

const version = async () => "codex-cli 0.0.0-test";

const helloManifest = (overrides: Record<string, unknown> = {}) =>
  manifestFor("hello", {
    prompt: "write hello.txt",
    expectations: [
      { kind: "status", equals: "completed" },
      { kind: "billing", equals: "subscription" },
      { kind: "fileContains", path: "hello.txt", text: "hello" },
      { kind: "diffTouchesOnly", globs: ["hello.txt"] },
    ],
    ...overrides,
  });

describe("runFixture", () => {
  it("live-runs on a fingerprint miss, grades, and persists the run", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    const report = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(report).toMatchObject({ fixture: "hello", mode: "live", state: "healthy" });
    expect(report.latestGrade.pass).toBe(true);
    expect(adapter.calls).toBe(1);

    const stored = await readResult(workdir, "hello");
    expect(stored?.runs).toHaveLength(1);
    expect(stored?.runs[0]?.adapterVersion).toBe("codex-cli 0.0.0-test");
    expect(stored?.runs[0]?.workdirDiff).toContain("hello.txt");
    expect(stored?.fingerprint).toMatch(/^sha256:/);
  });

  it("replays on a fingerprint hit without calling the adapter; --force runs live", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    const replay = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(replay.mode).toBe("replay");
    expect(replay.state).toBe("healthy");
    expect(adapter.calls).toBe(1);

    const forced = await runFixture({ workdir, fixture: "hello", adapter, force: true, adapterVersion: version });
    expect(forced.mode).toBe("live");
    expect(adapter.calls).toBe(2);
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(2);
  });

  it("re-grades the whole window against current expectations on replay", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });

    // Tighten the expectation so the recorded run no longer satisfies it.
    // Expectations are OUTSIDE the fingerprint, so this stays a replay hit.
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(helloManifest({ expectations: [{ kind: "fileContains", path: "hello.txt", text: "goodbye" }] }), null, 2) + "\n",
    );
    const replay = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(replay.mode).toBe("replay");
    expect(replay.state).toBe("failing");
    expect(adapter.calls).toBe(1);
    // The persisted grade reflects the re-grade.
    expect((await readResult(workdir, "hello"))?.runs[0]?.grade.pass).toBe(false);
  });

  it("resets history when the fingerprint changes", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    await runFixture({ workdir, fixture: "hello", adapter, force: true, adapterVersion: version });
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(2);

    await writeFile(join(dir, "manifest.json"), JSON.stringify(helloManifest({ prompt: "a different prompt" }), null, 2) + "\n");
    const report = await runFixture({ workdir, fixture: "hello", adapter, adapterVersion: version });
    expect(report.mode).toBe("live");
    expect((await readResult(workdir, "hello"))?.runs).toHaveLength(1);
  });

  it("records a failing grade and derives flaky from a mixed window", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    const good = evalAdapter({ "hello.txt": "hello\n" });
    const bad = evalAdapter({ "wrong.txt": "nope\n" });

    const first = await runFixture({ workdir, fixture: "hello", adapter: good, adapterVersion: version });
    expect(first.state).toBe("healthy");
    expect(first.debugWorkdir).toBeUndefined();
    const second = await runFixture({ workdir, fixture: "hello", adapter: bad, force: true, adapterVersion: version });
    expect(second.latestGrade.pass).toBe(false);
    expect(second.state).toBe("flaky");
    expect(second.debugWorkdir).toBeDefined();

    await rm(second.debugWorkdir as string, { recursive: true, force: true });
  });
});

describe("checkFixture", () => {
  it("reports stale when there is no result file", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: helloManifest() });
    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: true,
      state: null,
    });
  });

  it("reports stale on a fingerprint mismatch after inputs change", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(helloManifest({ prompt: "changed" }), null, 2) + "\n");
    const report = await checkFixture({ workdir, fixture: "hello", adapterName: "codex" });
    expect(report.stale).toBe(true);
  });

  it("re-grades from the recorded diff: expectation edits flip state with no new run", async () => {
    const workdir = await tempWorkdir();
    const dir = await makeFixture(workdir, "hello", { manifest: helloManifest() });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });

    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: false,
      state: "healthy",
    });

    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(helloManifest({ expectations: [{ kind: "fileContains", path: "hello.txt", text: "goodbye" }] }), null, 2) + "\n",
    );
    expect(await checkFixture({ workdir, fixture: "hello", adapterName: "codex" })).toEqual({
      fixture: "hello",
      stale: false,
      state: "failing",
    });
  });

  it("re-runs commandSucceeds against the reconstructed workdir", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", {
      manifest: manifestFor("hello", {
        expectations: [{ kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('hello.txt')\"" }],
      }),
    });
    await runFixture({ workdir, fixture: "hello", adapter: evalAdapter({ "hello.txt": "hello\n" }), adapterVersion: version });
    const report = await checkFixture({ workdir, fixture: "hello", adapterName: "codex" });
    expect(report.state).toBe("healthy");
  });
});
