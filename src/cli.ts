#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { CodexAdapter } from "./adapter/codex/index.js";
import type { Adapter } from "./adapter/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(opts: { adapter?: Adapter; writeOut?: (s: string) => void } = {}): Command {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);

  program
    .command("turn")
    .description("Run a single turn through an adapter and print the TurnResult")
    .argument("<prompt>", "the prompt for the turn")
    .option("--cwd <dir>", "working directory (a git repo)", process.cwd())
    .addOption(new Option("--effort <band>", "effort band").choices(["low", "medium", "high"]).default("medium"))
    .option("--model <model>", "model override (default: backend default)")
    .option("--timeout <seconds>", "turn timeout in seconds", (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("timeout must be a positive number");
      return n;
    })
    .action(async (prompt: string, options: { cwd: string; effort: "low" | "medium" | "high"; model?: string; timeout?: number }) => {
      const adapter = opts.adapter ?? new CodexAdapter();
      const result = await adapter.run({
        prompt,
        workdir: options.cwd,
        effort: options.effort,
        model: options.model,
        timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
      });
      writeOut(JSON.stringify(result, null, 2) + "\n");
      if (result.status !== "completed") process.exitCode = 1;
    });

  return program;
}

// argv[1] can be a symlink (e.g. a node_modules/.bin shim from `pnpm link`);
// realpath it before comparing so this still resolves to true through a link.
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
