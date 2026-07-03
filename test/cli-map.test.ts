import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { TEST_MAP_FILE } from "../src/map/store.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "map-repo");

afterEach(() => {
  process.exitCode = undefined;
});

async function runCli(args: string[]): Promise<{ out: string; code: number | undefined }> {
  let out = "";
  const program = buildProgram({ writeOut: (s) => (out += s) });
  // Without exitOverride, an unknown command would process.exit() and kill the worker.
  program.exitOverride();
  await program.parseAsync(["node", "tackle", ...args]);
  const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { out, code };
}

/** Copy the committed fixture so builds don't dirty the repo. */
async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tackle-cli-map-"));
  await cp(fixture, dir, { recursive: true });
  return dir;
}

describe("tackle map", () => {
  it("build --no-coverage writes a static-only map and reports counts", async () => {
    const dir = await fixtureCopy();
    const { out, code } = await runCli(["map", "build", "--no-coverage", "--cwd", dir]);
    expect(code).toBeUndefined();
    expect(out).toContain("static-only");
    expect((await stat(join(dir, TEST_MAP_FILE))).isFile()).toBe(true);
  });

  it("query lists tests with provenance after a build", async () => {
    const dir = await fixtureCopy();
    await runCli(["map", "build", "--no-coverage", "--cwd", dir]);
    const { out } = await runCli(["map", "query", "src/util.ts", "--cwd", dir]);
    expect(out).toContain("test/util.test.ts (static)");
  });

  it("query reports unmapped as a write-the-test-first signal", async () => {
    const dir = await fixtureCopy();
    await runCli(["map", "build", "--no-coverage", "--cwd", dir]);
    const { out, code } = await runCli(["map", "query", "src/unused.ts", "--cwd", dir]);
    expect(code).toBeUndefined(); // unmapped is a signal, not an error
    expect(out).toContain("unmapped");
    expect(out).toContain("write the test first");
  });

  it("query and status exit 1 when no map exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-map-"));
    const q = await runCli(["map", "query", "src/a.ts", "--cwd", dir]);
    expect(q.code).toBe(1);
    expect(q.out).toContain("tackle map build");
    const s = await runCli(["map", "status", "--cwd", dir]);
    expect(s.code).toBe(1);
  });

  it("status reports mode and counts", async () => {
    const dir = await fixtureCopy();
    await runCli(["map", "build", "--no-coverage", "--cwd", dir]);
    const { out } = await runCli(["map", "status", "--cwd", dir]);
    expect(out).toContain("static-only");
    expect(out).toMatch(/\d+ test file\(s\)/);
  });

  it("build degrades to static-only with a warning when vitest is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-cli-map-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "a.test.ts"), 'import { a } from "./src/a";\nexport const x = a;\n');
    const { out, code } = await runCli(["map", "build", "--cwd", dir]);
    expect(code).toBeUndefined();
    expect(out).toContain("warning: vitest not found");
    expect(out).toContain("static-only");
  });

  it("build rebuilds from scratch with a warning when the existing test map is corrupt", async () => {
    const dir = await fixtureCopy();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, TEST_MAP_FILE), "not valid json{{{");
    const { out, code } = await runCli(["map", "build", "--no-coverage", "--cwd", dir]);
    expect(code).toBeUndefined();
    expect(out).toContain("warning: existing test map is unreadable; rebuilding from scratch");
    expect(out).toContain("static-only");
    const written = JSON.parse(await readFile(join(dir, TEST_MAP_FILE), "utf8"));
    expect(written.version).toBe(1);
    expect(written.mode).toBe("static-only");
  });
});
