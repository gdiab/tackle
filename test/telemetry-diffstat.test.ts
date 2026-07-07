import { describe, expect, it } from "vitest";
import { parseDiffStats } from "../src/telemetry/diffstat.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line",
  "-old",
  "+new",
  "+added",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "",
].join("\n");

describe("parseDiffStats", () => {
  it("counts insertions and deletions per file, sorted by path", () => {
    expect(parseDiffStats(DIFF)).toEqual([
      { path: "src/a.ts", insertions: 2, deletions: 1 },
      { path: "src/gone.ts", insertions: 0, deletions: 1 },
      { path: "src/new.ts", insertions: 2, deletions: 0 },
    ]);
  });

  it("returns [] for an empty diff", () => {
    expect(parseDiffStats("")).toEqual([]);
  });

  it("omits binary files (no text hunks to count)", () => {
    const binary = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(parseDiffStats(binary)).toEqual([]);
  });

  it("counts hunk content lines that merely look like headers as content", () => {
    const tricky = [
      "diff --git a/x.ts b/x.ts",
      "index 1111111..2222222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "--- a/sneaky.ts", // a deleted content line, not a file header
      "+++ b/sneaky.ts", // an added content line, not a file header
      "",
    ].join("\n");
    expect(parseDiffStats(tricky)).toEqual([{ path: "x.ts", insertions: 1, deletions: 1 }]);
  });

  it("is total garbage-tolerant: nonsense input yields []", () => {
    expect(parseDiffStats("not a diff\nat all\n")).toEqual([]);
  });
});
