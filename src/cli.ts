import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);
  return program;
}

const isMain = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isMain) {
  buildProgram().parseAsync(process.argv);
}
