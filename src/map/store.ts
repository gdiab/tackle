import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestMapFile } from "./types.js";

export const TEST_MAP_FILE = ".tackle/test-map.json";

export async function readTestMap(workdir: string): Promise<TestMapFile | null> {
  let raw: string;
  try {
    raw = await readFile(join(workdir, TEST_MAP_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${TEST_MAP_FILE} is not valid JSON; delete it and re-run \`tackle map build\``);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${TEST_MAP_FILE} does not contain a JSON object; delete it and re-run \`tackle map build\``);
  }
  const map = parsed as TestMapFile;
  if (map.version !== 1) throw new Error(`unsupported ${TEST_MAP_FILE} version; expected 1`);
  const isPlainObject = (value: unknown): boolean =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isPlainObject(map.tests) || !isPlainObject(map.sources)) {
    throw new Error(
      `${TEST_MAP_FILE} is missing its tests/sources structure; delete it and re-run \`tackle map build\``,
    );
  }
  return map;
}

export async function writeTestMap(workdir: string, map: TestMapFile): Promise<void> {
  await mkdir(join(workdir, ".tackle"), { recursive: true });
  const target = join(workdir, TEST_MAP_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2) + "\n");
  await rename(tmp, target);
}
