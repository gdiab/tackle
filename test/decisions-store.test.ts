import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDecision,
  DECISIONS_FILE,
  formatDecisionId,
  parseDecisions,
  readDecisions,
} from "../src/decisions/store.js";
import { tempWorkdir } from "./helpers/workflow.js";

const SAMPLE = `# Decisions

## D-001 — 2026-07-06 — Ship telemetry ledger as JSONL

- **Decision:** per-turn append-only ledger, digest computed on read
- **Rejected:** aggregate session-digest.json (read-modify-write)
- **Source:** human

## D-002 — 2026-07-07 — Second thing

- **Decision:** did it
- **Source:** workflow
`;

describe("parseDecisions", () => {
  it("parses IDs, dates, titles, bullets, and sources", () => {
    const entries = parseDecisions(SAMPLE);
    expect(entries).toEqual([
      {
        id: 1,
        date: "2026-07-06",
        title: "Ship telemetry ledger as JSONL",
        decision: "per-turn append-only ledger, digest computed on read",
        rejected: ["aggregate session-digest.json (read-modify-write)"],
        source: "human",
      },
      { id: 2, date: "2026-07-07", title: "Second thing", decision: "did it", rejected: [], source: "workflow" },
    ]);
  });

  it("empty or preamble-only content parses to []", () => {
    expect(parseDecisions("")).toEqual([]);
    expect(parseDecisions("# Decisions\n\nsome prose\n")).toEqual([]);
  });

  it("throws on an unparseable heading", () => {
    expect(() => parseDecisions("## not a decision heading\n")).toThrow(/unparseable heading/);
  });

  it("throws on a missing Decision or Source line, and on an invalid source", () => {
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Source:** human\n")).toThrow(/missing/);
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Decision:** d\n")).toThrow(/missing/);
    expect(() => parseDecisions("## D-001 — 2026-07-07 — t\n\n- **Decision:** d\n- **Source:** robot\n")).toThrow(/source/);
  });
});

describe("appendDecision", () => {
  it("creates the file on first append and round-trips through the parser", async () => {
    const dir = await tempWorkdir();
    const id = await appendDecision(
      dir,
      { title: "First", decision: "do X", rejected: ["do Y", "do Z"], source: "human" },
      "2026-07-07",
    );
    expect(id).toBe("D-001");
    const entries = await readDecisions(dir);
    expect(entries).toEqual([
      { id: 1, date: "2026-07-07", title: "First", decision: "do X", rejected: ["do Y", "do Z"], source: "human" },
    ]);
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toContain("# Decisions");
  });

  it("assigns max ID + 1 and appends at the bottom", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), SAMPLE);
    const id = await appendDecision(dir, { title: "Third", decision: "d3", rejected: [], source: "workflow" }, "2026-07-07");
    expect(id).toBe("D-003");
    const entries = await readDecisions(dir);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries[2]?.title).toBe("Third");
  });

  it("refuses to append to an unparseable file, changing nothing", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, DECISIONS_FILE), "## broken heading\n");
    await expect(appendDecision(dir, { title: "x", decision: "y", rejected: [], source: "human" })).rejects.toThrow(
      /unparseable heading/,
    );
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toBe("## broken heading\n");
  });

  it("collapses newlines in field text and rejects a blank title", async () => {
    const dir = await tempWorkdir();
    await appendDecision(dir, { title: "multi\nline", decision: "a\nb", rejected: [], source: "human" }, "2026-07-07");
    const entries = await readDecisions(dir);
    expect(entries[0]?.title).toBe("multi line");
    expect(entries[0]?.decision).toBe("a b");
    await expect(appendDecision(dir, { title: "  \n ", decision: "d", rejected: [], source: "human" })).rejects.toThrow(/title/);
  });

  it("missing file reads as []", async () => {
    expect(await readDecisions(await tempWorkdir())).toEqual([]);
  });
});

describe("formatDecisionId", () => {
  it("pads to three digits and grows past 999", () => {
    expect(formatDecisionId(7)).toBe("D-007");
    expect(formatDecisionId(1234)).toBe("D-1234");
  });
});
