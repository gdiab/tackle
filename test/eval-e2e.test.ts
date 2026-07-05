import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { evalAdapter, makeFixture, manifestFor } from "./helpers/evals.js";
import { tempWorkdir } from "./helpers/workflow.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("eval end-to-end", () => {
  it("run records a graded result; check and status agree; replay is fully reconstructive", async () => {
    const workdir = await tempWorkdir();
    await makeFixture(workdir, "create-file", {
      manifest: manifestFor("create-file", {
        prompt: "Create a file named hello.txt containing exactly the word: hello",
        expectations: [
          { kind: "status", equals: "completed" },
          { kind: "billing", equals: "subscription" },
          { kind: "fileExists", path: "hello.txt" },
          { kind: "fileContains", path: "hello.txt", text: "hello" },
          { kind: "diffTouchesOnly", globs: ["hello.txt"] },
          { kind: "commandSucceeds", command: "node -e \"require('node:fs').accessSync('hello.txt')\"" },
        ],
      }),
      seed: { "README.md": "fixture seed\n" },
    });
    const adapter = evalAdapter({ "hello.txt": "hello\n" });

    const parse = async (argv: string[]) => {
      const out: string[] = [];
      const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
      program.exitOverride();
      await program.parseAsync(argv, { from: "user" });
      return out.join("");
    };

    // 1. Live run: one adapter call, passing grade, committed-shape result file on disk.
    const runOut = await parse(["eval", "run", "--cwd", workdir]);
    expect(runOut).toContain("create-file: live pass (healthy)");
    expect(adapter.calls).toBe(1);
    await access(join(workdir, "evals", "results", "create-file.json"));
    expect(process.exitCode).toBeUndefined();

    // 2. Check: replay-only — reconstructs seed + diff and re-runs every grader,
    //    including commandSucceeds, without touching the adapter.
    const checkOut = await parse(["eval", "check", "--cwd", workdir]);
    expect(checkOut).toContain("create-file: healthy");
    expect(adapter.calls).toBe(1);
    expect(process.exitCode).toBeUndefined();

    // 3. Status: reads the stored window.
    const statusOut = await parse(["eval", "status", "--cwd", workdir]);
    expect(statusOut).toMatch(/create-file\s+healthy\s+1\/1/);

    // 4. Second run replays rather than spending a turn.
    const replayOut = await parse(["eval", "run", "--cwd", workdir]);
    expect(replayOut).toContain("create-file: replay pass (healthy)");
    expect(adapter.calls).toBe(1);
  });
});
