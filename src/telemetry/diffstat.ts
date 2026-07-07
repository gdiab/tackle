export interface FileTouch {
  path: string;
  insertions: number;
  deletions: number;
}

/**
 * Numstat-style per-file line counts from a unified diff. File headers
 * (`---`/`+++`) are only honored outside hunks — inside a hunk a line starting
 * with `-`/`+` is content, even if it reads like a header (same hardening as
 * evals' diffPaths). Binary files have no hunks and are omitted.
 */
export function parseDiffStats(diff: string): FileTouch[] {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  let current: { insertions: number; deletions: number } | null = null;
  let oldPath: string | null = null;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      oldPath = line.slice(4);
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const newPath = line.slice(4);
      let path: string | null = null;
      if (newPath !== "/dev/null" && newPath.startsWith("b/")) path = newPath.slice(2);
      else if (newPath === "/dev/null" && oldPath !== null && oldPath.startsWith("a/")) path = oldPath.slice(2);
      if (path !== null) {
        const existing = stats.get(path) ?? { insertions: 0, deletions: 0 };
        stats.set(path, existing);
        current = existing;
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || current === null) continue;
    if (line.startsWith("+")) current.insertions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }

  return [...stats.entries()]
    .map(([path, s]) => ({ path, insertions: s.insertions, deletions: s.deletions }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
