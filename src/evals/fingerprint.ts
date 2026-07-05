import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "../workflow/hash.js";
import type { FixtureManifest } from "./manifest.js";

/** Deterministic JSON: recursively sorted object keys, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sorted (relative path, content sha256) pairs for every file under seed/; [] when there is no seed. */
async function seedEntries(fixtureDir: string): Promise<Array<[string, string]>> {
  const seedDir = join(fixtureDir, "seed");
  let dirents;
  try {
    dirents = await readdir(seedDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: Array<[string, string]> = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const abs = join(dirent.parentPath, dirent.name);
    entries.push([relative(seedDir, abs), sha256(await readFile(abs, "utf8"))]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries;
}

/**
 * Fingerprint over run-affecting inputs ONLY: prompt, effort, timeoutSeconds,
 * seed content, adapter name. Expectations are deliberately excluded so
 * grading changes never invalidate cached runs (see the design doc).
 */
export async function computeFingerprint(opts: {
  fixtureDir: string;
  manifest: FixtureManifest;
  adapterName: string;
}): Promise<string> {
  const input = canonicalJson({
    adapter: opts.adapterName,
    prompt: opts.manifest.prompt,
    effort: opts.manifest.effort,
    timeoutSeconds: opts.manifest.timeoutSeconds,
    seed: await seedEntries(opts.fixtureDir),
  });
  return `sha256:${sha256(input)}`;
}
