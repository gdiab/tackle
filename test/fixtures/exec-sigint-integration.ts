// Standalone fixture for the full-process SIGINT integration test in
// test/exec.test.ts. Run directly via `node --experimental-strip-types` as
// its own OS process (not imported into the vitest worker) so a real SIGINT
// can be delivered to it without touching the test runner's own process.
//
// Note: this imports exec.ts by its literal .ts extension (unlike the
// project's own NodeNext ".js" convention) because Node's native type
// stripping does not remap ".js" specifiers to ".ts" files the way tsc/tsx
// do; this file is excluded from tsconfig's "src" rootDir so it is not
// type-checked as part of the project build.
import { runCommand } from "../../src/adapter/exec.ts";

const env = { PATH: process.env.PATH ?? "" };

await runCommand({
  cmd: process.execPath,
  args: [
    "-e",
    `const gc = require("child_process").spawn("sleep", ["30"], { stdio: "inherit" }); console.log("grandchild:" + gc.pid); setTimeout(() => {}, 60_000);`,
  ],
  cwd: process.cwd(),
  env,
  timeoutMs: 20_000,
  onLine: (line) => console.log(line),
});
