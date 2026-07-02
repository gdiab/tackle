#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();
  program.name("tackle").description("Bespoke agentic dev harness").version(pkg.version);
  return program;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  buildProgram().parseAsync(process.argv);
}
