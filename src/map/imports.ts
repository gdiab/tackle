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

  function importsOf(absFile: string): string[] {
    let content: string;
    try {
      content = readFileSync(absFile, "utf8");
    } catch {
      return [];
    }
    const resolved: string[] = [];
    for (const imp of ts.preProcessFile(content, true, true).importedFiles) {
      const mod = ts.resolveModuleName(imp.fileName, absFile, options, ts.sys).resolvedModule;
      if (mod === undefined || mod.isExternalLibraryImport === true) continue;
      if (mod.resolvedFileName.includes(`${sep}node_modules${sep}`)) continue;
      resolved.push(resolve(mod.resolvedFileName));
    }
    return resolved;
  }

  return {
    sourcesFor(testFileRel: string): string[] {
      const start = resolve(root, testFileRel);
      const visited = new Set<string>([start]);
      const queue = [start];
      for (;;) {
        const file = queue.pop();
        if (file === undefined) break;
        for (const dep of importsOf(file)) {
          if (visited.has(dep)) continue;
          visited.add(dep);
          queue.push(dep);
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
