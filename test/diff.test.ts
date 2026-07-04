import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, resolveHead } from "../src/adapter/diff.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-diff-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "original\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("workdir diff", () => {
  it("resolves HEAD to a full sha", async () => {
    const dir = makeRepo();
    expect(await resolveHead(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns empty string for a clean workdir", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    expect(await captureWorkdirDiff(dir, base)).toBe("");
  });

  it("captures tracked modifications against the base ref", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("-original");
    expect(diff).toContain("+changed");
  });

  it("captures untracked files as new-file diffs", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "brand-new.txt"), "fresh\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("brand-new.txt");
    expect(diff).toContain("+fresh");
  });

  it("captures an empty untracked file as a new-file diff", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "empty.txt"), "");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("empty.txt");
  });

  it("captures untracked files with non-ASCII names", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    writeFileSync(join(dir, "café-ñ.txt"), "unicode content\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("+unicode content");
  });

  it("throws (not silently succeeds) for a non-git workdir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tackle-nogit-"));
    await expect(captureWorkdirDiff(dir, "HEAD")).rejects.toThrow();
  });

  it("captures commits the turn made (diff vs pre-turn ref)", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
    writeFileSync(join(dir, "a.txt"), "committed change\n");
    git("add", ".");
    git("commit", "-q", "-m", "agent commit");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("+committed change");
  });

  it("excludes harness state under .tackle/ from the diff", async () => {
    const dir = makeRepo();
    const base = await resolveHead(dir);
    mkdirSync(join(dir, ".tackle", "transcripts"), { recursive: true });
    writeFileSync(join(dir, ".tackle", "transcripts", "old-turn.jsonl"), "{}\n");
    writeFileSync(join(dir, "real-change.txt"), "content\n");
    const diff = await captureWorkdirDiff(dir, base);
    expect(diff).toContain("real-change.txt");
    expect(diff).not.toContain(".tackle");
  });
});
