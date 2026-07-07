// test/cli-telemetry.test.ts
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import { appendTurnRecord, TURNS_FILE, type TurnRecordV1 } from "../src/telemetry/ledger.js";
import { tempWorkdir } from "./helpers/workflow.js";

function rec(overrides: Partial<TurnRecordV1> = {}): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: new Date().toISOString(),
    context: "turn",
    durationMs: 1000,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" },
    tokens: { inputTokens: 100, cacheReadInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
    filesTouched: [],
    sessionId: null,
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

async function run(args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ writeOut: (s) => out.push(s) });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return out.join("");
}

afterEach(() => vi.restoreAllMocks());

describe("tackle telemetry", () => {
  it("renders the text report over the ledger", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec());
    await appendTurnRecord(dir, rec({ context: "phase:build" }));
    const text = await run(["telemetry", "--cwd", dir]);
    expect(text).toContain("turns: 2");
    expect(text).toContain("phase:build");
  });

  it("--json emits the machine-readable report including the malformed count", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec());
    await appendFile(join(dir, TURNS_FILE), "garbage\n");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const parsed = JSON.parse(await run(["telemetry", "--cwd", dir, "--json"]));
    expect(parsed.schema).toBe("telemetry-report/v1");
    expect(parsed.turns).toBe(1);
    expect(parsed.malformed).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });

  it("--since filters to the trailing window", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, rec({ at: "2020-01-01T00:00:00.000Z" }));
    await appendTurnRecord(dir, rec());
    const text = await run(["telemetry", "--cwd", dir, "--since", "7d"]);
    expect(text).toContain("turns: 1");
  });

  it("rejects a malformed --since", async () => {
    const dir = await tempWorkdir();
    await expect(run(["telemetry", "--cwd", dir, "--since", "fortnight"])).rejects.toThrow();
  });

  it("empty ledger prints a friendly line and exits 0", async () => {
    const dir = await tempWorkdir();
    const text = await run(["telemetry", "--cwd", dir]);
    expect(text).toContain("no turns recorded");
  });
});
