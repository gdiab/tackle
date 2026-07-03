import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTestMap, TEST_MAP_FILE, writeTestMap } from "../src/map/store.js";
import type { TestMapFile } from "../src/map/types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tackle-map-"));
}

function sampleMap(): TestMapFile {
  return {
    version: 1,
    builtAt: "2026-07-03T00:00:00.000Z",
    mode: "full",
    tests: {
      "test/a.test.ts": { hash: "abc", sources: { "src/a.ts": "both" } },
    },
    sources: { "src/a.ts": ["test/a.test.ts"] },
  };
}

describe("test-map store", () => {
  it("returns null when no map exists", async () => {
    expect(await readTestMap(await tempDir())).toBeNull();
  });

  it("round-trips a map under .tackle/ with a trailing newline", async () => {
    const dir = await tempDir();
    await writeTestMap(dir, sampleMap());
    expect(await readTestMap(dir)).toEqual(sampleMap());
    const raw = await readFile(join(dir, TEST_MAP_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("rejects invalid JSON with a rebuild hint", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), "not json");
    await expect(readTestMap(dir)).rejects.toThrow(/tackle map build/);
  });

  it("rejects a non-object body", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), "[1]");
    await expect(readTestMap(dir)).rejects.toThrow(/JSON object/);
  });

  it("rejects an unsupported version", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), JSON.stringify({ version: 2 }));
    await expect(readTestMap(dir)).rejects.toThrow(/version/);
  });
});
