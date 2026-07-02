import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { approveAll, fakeTurn, rejectAll } from "./helpers/workflow.js";

function artifactWritingAdapter(relPath: string): Adapter & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    name: "fake",
    requests,
    run: async (req: TurnRequest) => {
      requests.push(req);
      await mkdir(join(req.workdir, ".tackle"), { recursive: true });
      await writeFile(join(req.workdir, relPath), "# artifact");
      return fakeTurn();
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("tackle phase commands", () => {
  it("tackle specs runs the phase and exits 0 on approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const adapter = artifactWritingAdapter(".tackle/specs.md");
    const program = buildProgram({ adapter, presenter: approveAll, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.status).toBe("approved");
    expect(adapter.requests[0]?.effort).toBe("medium");
  });

  it("passes effort, model, and timeout through to the adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const adapter = artifactWritingAdapter(".tackle/specs.md");
    const program = buildProgram({ adapter, presenter: approveAll, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(
      ["specs", "r", "--cwd", dir, "--effort", "high", "--model", "gpt-x", "--timeout", "30"],
      { from: "user" },
    );
    expect(adapter.requests[0]?.effort).toBe("high");
    expect(adapter.requests[0]?.model).toBe("gpt-x");
    expect(adapter.requests[0]?.timeoutMs).toBe(30_000);
  });

  it("sets exit code 1 when the human declines the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/specs.md"),
      presenter: rejectAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await program.parseAsync(["specs", "r", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it("tackle plan --skip-specs without a request is an error", async () => {
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/plan.md"),
      presenter: approveAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await expect(
      program.parseAsync(["plan", "--skip-specs"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("tackle pr takes no request argument", async () => {
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/pr.md"),
      presenter: approveAll,
      writeOut: () => {},
    });
    program.exitOverride();
    await expect(program.parseAsync(["pr", "unexpected"], { from: "user" })).rejects.toThrow();
  });

  it("tackle status reports no workflow, then per-phase status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-"));
    const out: string[] = [];
    const program = buildProgram({
      adapter: artifactWritingAdapter(".tackle/specs.md"),
      presenter: approveAll,
      writeOut: (s) => out.push(s),
    });
    program.exitOverride();
    await program.parseAsync(["status", "--cwd", dir], { from: "user" });
    expect(out.join("")).toContain("no workflow in progress");

    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    out.length = 0;
    await program.parseAsync(["status", "--cwd", dir], { from: "user" });
    const text = out.join("");
    expect(text).toContain("request: add a widget");
    expect(text).toContain("entry: specs");
    expect(text).toMatch(/specs\s+approved/);
    expect(text).toMatch(/plan\s+pending/);
  });
});
