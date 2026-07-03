import { readdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/** Test-file heuristic shared by discovery, edge filtering, and coverage parsing. */
export function isTestFile(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath) || relPath.split("/").includes("__tests__");
}

/** Repo-relative, sorted, /-separated test file paths under workdir. */
export async function discoverTestFiles(workdir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(workdir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(childRel);
      } else if (entry.isFile() && isTestFile(childRel)) {
        found.push(childRel);
      }
    }
  }
  await walk("");
  return found.sort();
}
