import { describe, expect, it } from "vitest";
import { blockingFindings, parseVerdict } from "../src/workflow/verdict.js";

const wrap = (json: string) => "Review complete.\n\n```json\n" + json + "\n```\n";

describe("parseVerdict", () => {
  it("parses a clean verdict", () => {
    const v = parseVerdict(wrap('{ "verdict": "clean", "findings": [] }'));
    expect(v).toEqual({ verdict: "clean", findings: [] });
  });

  it("parses findings with optional fields", () => {
    const v = parseVerdict(
      wrap(
        '{ "verdict": "findings", "findings": [' +
          '{ "severity": "blocking", "file": "src/a.ts", "line": 3, "summary": "bug", "detail": "why" },' +
          '{ "severity": "note", "file": "src/b.ts", "summary": "style" }] }',
      ),
    );
    expect(v?.findings).toHaveLength(2);
    expect(blockingFindings(v!)).toHaveLength(1);
    expect(v?.findings[0]).toEqual({ severity: "blocking", file: "src/a.ts", line: 3, summary: "bug", detail: "why" });
  });

  it("uses the LAST fenced json block (models sometimes quote the format first)", () => {
    const text = wrap('{ "verdict": "findings", "findings": [] }') + wrap('{ "verdict": "clean", "findings": [] }');
    expect(parseVerdict(text)?.verdict).toBe("clean");
  });

  it("returns null on missing block, bad json, or bad shape", () => {
    expect(parseVerdict("no block here")).toBeNull();
    expect(parseVerdict(wrap("not json"))).toBeNull();
    expect(parseVerdict(wrap('{ "verdict": "maybe", "findings": [] }'))).toBeNull();
    expect(parseVerdict(wrap('{ "verdict": "clean", "findings": [{ "severity": "huge" }] }'))).toBeNull();
  });

  it("rejects explicit null findings but tolerates an absent findings key", () => {
    expect(parseVerdict(wrap('{ "verdict": "findings", "findings": null }'))).toBeNull();
    expect(parseVerdict(wrap('{ "verdict": "clean" }'))).toEqual({ verdict: "clean", findings: [] });
  });
});
