import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { isTestFile } from "./testfiles.js";

export interface ImportWalker {
  /** Sorted repo-relative, non-test, in-repo files reachable from the test file's imports. */
  sourcesFor(testFileRel: string): string[];
}

// Only the workdir's own tsconfig counts — walking up would let an enclosing
// repo's config leak into a nested fixture or sub-project.
function loadCompilerOptions(workdir: string): ts.CompilerOptions {
  const configPath = join(workdir, "tsconfig.json");
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (!ts.sys.fileExists(configPath)) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) return fallback;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, workdir).options;
}

export function createImportWalker(workdir: string): ImportWalker {
  const root = resolve(workdir);
  const options = loadCompilerOptions(root);
  // Every build now walks every test file, so shared helpers get re-read/
  // re-parsed once per test file that reaches them without this memo. The
  // walker is created once per build, so the cache's lifetime is exactly one
  // build — no staleness concern.
  const cache = new Map<string, string[]>();

  function importsOf(absFile: string): string[] {
    const cached = cache.get(absFile);
    if (cached !== undefined) return cached;
    let content: string;
    try {
      content = readFileSync(absFile, "utf8");
    } catch {
      cache.set(absFile, []);
      return [];
    }
    const resolved: string[] = [];
    for (const imp of ts.preProcessFile(content, true, true).importedFiles) {
      const mod = ts.resolveModuleName(imp.fileName, absFile, options, ts.sys).resolvedModule;
      if (mod === undefined || mod.isExternalLibraryImport === true) continue;
      if (mod.resolvedFileName.includes(`${sep}node_modules${sep}`)) continue;
      resolved.push(resolve(mod.resolvedFileName));
    }
    cache.set(absFile, resolved);
    return resolved;
  }

  return {
    sourcesFor(testFileRel: string): string[] {
      const start = resolve(root, testFileRel);
      const visited = new Set<string>([start]);
      const stack = [start];
      for (;;) {
        const file = stack.pop();
        if (file === undefined) break;
        for (const dep of importsOf(file)) {
          if (visited.has(dep)) continue;
          visited.add(dep);
          stack.push(dep);
        }
      }
      const sources: string[] = [];
      for (const abs of visited) {
        if (abs === start) continue;
        const rel = relative(root, abs).split(sep).join("/");
        if (rel.startsWith("..") || isTestFile(rel)) continue;
        sources.push(rel);
      }
      return sources.sort();
    },
  };
}
