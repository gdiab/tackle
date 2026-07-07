// test/cli-decision.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { DECISIONS_FILE, readDecisions } from "../src/decisions/store.js";
import { tempWorkdir } from "./helpers/workflow.js";

async function run(args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return out.join("");
}

describe("tackle decision", () => {
  it("add appends with sequential IDs and repeatable --rejected; source is human", async () => {
    const dir = await tempWorkdir();
    const first = await run(["decision", "add", "Pick JSONL", "--decision", "ledger is JSONL", "--cwd", dir]);
    expect(first).toContain("D-001");
    await run([
      "decision", "add", "Second", "--decision", "did it",
      "--rejected", "alt one", "--rejected", "alt two", "--cwd", dir,
    ]);
    const entries = await readDecisions(dir);
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
    expect(entries[1]?.rejected).toEqual(["alt one", "alt two"]);
    expect(entries.every((e) => e.source === "human")).toBe(true);
  });

  it("add requires --decision", async () => {
    const dir = await tempWorkdir();
    await expect(run(["decision", "add", "t", "--cwd", dir])).rejects.toThrow();
  });

  it("add refuses on an unparseable file with a clear error", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), "## broken\n");
    await expect(run(["decision", "add", "t", "--decision", "d", "--cwd", dir])).rejects.toThrow(/unparseable/);
  });

  it("list prints one line per entry: ID, date, title, source", async () => {
    const dir = await tempWorkdir();
    await run(["decision", "add", "Pick JSONL", "--decision", "d", "--cwd", dir]);
    const text = await run(["decision", "list", "--cwd", dir]);
    expect(text).toMatch(/D-001\s+\d{4}-\d{2}-\d{2}\s+Pick JSONL\s+\(human\)/);
  });

  it("list on no file says so", async () => {
    const dir = await tempWorkdir();
    expect(await run(["decision", "list", "--cwd", dir])).toContain("no decisions recorded");
  });
});
