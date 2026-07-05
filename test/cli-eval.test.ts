import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

afterEach(() => {
  process.exitCode = undefined;
});

async function cli(argv: string[], adapter = evalAdapter({ "hello.txt": "hello\n" })) {
  const out: string[] = [];
  const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(argv, { from: "user" });
  return { out: out.join(""), adapter };
}

const passingManifest = manifestFor("hello", {
  expectations: [
    { kind: "status", equals: "completed" },
    { kind: "fileContains", path: "hello.txt", text: "hello" },
  ],
});

describe("tackle eval run", () => {
  it("live-runs all fixtures, prints mode and verdict, exits 0 on pass", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "run", "--cwd", workdir]);
    expect(out).toContain("hello: live pass (healthy)");
    expect(process.exitCode).toBeUndefined();
  });

  it("replays on the second invocation and says so", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    await cli(["eval", "run", "--cwd", workdir], adapter);
    const { out } = await cli(["eval", "run", "--cwd", workdir], adapter);
    expect(out).toContain("hello: replay pass (healthy)");
    expect(adapter.calls).toBe(1);
  });

  it("prints per-expectation failures and exits nonzero on a failing grade", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "run", "--cwd", workdir], evalAdapter({ "wrong.txt": "nope\n" }));
    expect(out).toContain("hello: live fail");
    expect(out).toContain("fail fileContains: hello.txt does not exist");
    expect(out).toContain("turn workdir kept:");
    expect(process.exitCode).toBe(1);
  });

  it("runs only the named fixtures and errors when there are none at all", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "a", { manifest: manifestFor("a") });
    await makeFixture(workdir, "b", { manifest: manifestFor("b") });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });
    const { out } = await cli(["eval", "run", "b", "--cwd", workdir], adapter);
    expect(out).toContain("b:");
    expect(out).not.toContain("a:");

    const empty = await tempWorkdir();
    const result = await cli(["eval", "run", "--cwd", empty]);
    expect(result.out).toContain("no fixtures");
    expect(process.exitCode).toBe(1);
  });
});

describe("tackle eval status", () => {
  it("prints the state table from stored results and always exits 0", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    await makeFixture(workdir, "unrun", { manifest: manifestFor("unrun") });
    await cli(["eval", "run", "hello", "--cwd", workdir]);
    const { out } = await cli(["eval", "status", "--cwd", workdir]);
    expect(out).toMatch(/hello\s+healthy\s+1\/1\s+1 run/);
    expect(out).toMatch(/unrun\s+no runs/);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("tackle eval check", () => {
  it("fails on a stale (never-run) fixture with re-run guidance", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    const { out } = await cli(["eval", "check", "--cwd", workdir]);
    expect(out).toContain("hello: stale");
    expect(out).toContain("tackle eval run hello");
    expect(process.exitCode).toBe(1);
  });

  it("passes on healthy, fails on failing, warns-but-passes on flaky", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "hello", { manifest: passingManifest });
    await cli(["eval", "run", "--cwd", workdir]);
    let result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: healthy");
    expect(process.exitCode).toBeUndefined();

    // Mixed window -> flaky -> warn, exit 0. The force-run itself fails its
    // grade and sets exitCode 1; clear it so the assertion below is about check.
    await cli(["eval", "run", "--cwd", workdir, "--force"], evalAdapter({ "wrong.txt": "x\n" }));
    process.exitCode = undefined;
    result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: flaky");
    expect(result.out).toContain("hello: flaky (warning — not blocking)");
    expect(process.exitCode).toBeUndefined();

    // Expectation nobody can meet -> every run re-grades to fail -> failing -> exit 1.
    const dir = join(workdir, "evals", "fixtures", "hello");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(manifestFor("hello", { expectations: [{ kind: "fileExists", path: "never.txt" }] }), null, 2) + "\n",
    );
    result = await cli(["eval", "check", "--cwd", workdir]);
    expect(result.out).toContain("hello: failing");
    expect(process.exitCode).toBe(1);
  });
});
