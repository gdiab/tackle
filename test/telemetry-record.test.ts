import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapter/types.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { recordedRun } from "../src/telemetry/record.js";
import { fakeTurn, scriptedAdapter, tempWorkdir } from "./helpers/workflow.js";

const REQ = { prompt: "p", workdir: "/w", effort: "medium" as const };

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " keep",
  "+new",
  "",
].join("\n");

describe("recordedRun", () => {
  it("returns the result unchanged and appends one record with the context", async () => {
    const dir = await tempWorkdir();
    const result = fakeTurn({ workdirDiff: DIFF, status: "completed" });
    const adapter = scriptedAdapter([async () => result]);
    const returned = await recordedRun(adapter, REQ, { repoDir: dir, context: "phase:build" });
    expect(returned).toBe(result); // identity, not a copy
    const { records } = await readTurnRecords(dir);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r?.schema).toBe("turn-record/v1");
    expect(r?.context).toBe("phase:build");
    expect(r?.status).toBe("completed");
    expect(r?.billingType).toBe("subscription");
    expect(r?.filesTouched).toEqual([{ path: "src/a.ts", insertions: 1, deletions: 0 }]);
    expect(r?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(r?.at ?? ""))).toBe(false);
    expect(r?.transcriptRef).toBe(result.transcriptRef);
    expect(r?.sessionId).toBe(result.sessionId);
  });

  it("a failed ledger append warns and still returns the result", async () => {
    const dir = await tempWorkdir();
    // make .tackle a FILE so mkdir(.tackle/telemetry) fails
    await writeFile(join(dir, ".tackle"), "not a dir");
    const warnings: string[] = [];
    const result = fakeTurn();
    const adapter = scriptedAdapter([async () => result]);
    const returned = await recordedRun(adapter, REQ, {
      repoDir: dir,
      context: "turn",
      warn: (m) => warnings.push(m),
    });
    expect(returned).toBe(result);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("telemetry");
  });

  it("an adapter throw propagates and records nothing", async () => {
    const dir = await tempWorkdir();
    const adapter: Adapter = {
      name: "boom",
      run: async () => {
        throw new Error("spawn failed");
      },
    };
    await expect(recordedRun(adapter, REQ, { repoDir: dir, context: "turn" })).rejects.toThrow("spawn failed");
    expect((await readTurnRecords(dir)).records).toHaveLength(0);
  });
});
