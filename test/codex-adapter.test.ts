import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter/codex/index.js";

const fakesDir = resolve("test/fakes");
const fixturesDir = resolve("test/fixtures");

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-adapter-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "original\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

function makeAdapter(knobs: {
  fixture?: string;
  exitCode?: number;
  sleepMs?: number;
  deleteGitDir?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "tackle-home-"));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  writeFileSync(join(home, ".fake-codex.json"), JSON.stringify(knobs));
  return new CodexAdapter({
    baseEnv: { PATH: `${fakesDir}:${process.env.PATH}`, HOME: home },
    authPath: join(home, "auth.json"),
  });
}

describe("CodexAdapter", () => {
  it("grades a successful turn as completed with usage, session, summary, and billing", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ fixture: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "say hi", workdir, effort: "medium" });

    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("019f23af-eb41-7b92-a92e-c4d44bb55af1");
    expect(result.summary).toBe("hi");
    expect(result.usage.billingType).toBe("subscription");
    expect(result.usage.tokens).toEqual({
      inputTokens: 13966 - 5504,
      cacheReadInputTokens: 5504,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
    expect(result.authorship).toEqual({ adapter: "codex", model: null, effort: "medium" });
    expect(result.workdirDiff).toBe("");
  });

  it("writes the raw stream to a transcript file under .tackle/", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ fixture: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "say hi", workdir, effort: "low" });

    expect(result.transcriptRef).toContain(join(workdir, ".tackle", "transcripts"));
    expect(existsSync(result.transcriptRef)).toBe(true);
    expect(readFileSync(result.transcriptRef, "utf8")).toContain('"turn.completed"');
  });

  it("grades turn.failed as tool_error", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({ fixture: join(fixturesDir, "codex-failed.jsonl") });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.status).toBe("tool_error");
  });

  it("grades a nonzero exit as tool_error even with a complete stream", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({
      fixture: join(fixturesDir, "codex-completed.jsonl"),
      exitCode: 2,
    });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.status).toBe("tool_error");
  });

  it("grades a hung child as timeout", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({
      fixture: join(fixturesDir, "codex-completed.jsonl"),
      sleepMs: 60000,
    });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium", timeoutMs: 1_000 });
    expect(result.status).toBe("timeout");
  });

  it("writes the transcript even when diff capture fails", async () => {
    const workdir = makeRepo();
    const adapter = makeAdapter({
      fixture: join(fixturesDir, "codex-completed.jsonl"),
      deleteGitDir: true,
    });
    await expect(adapter.run({ prompt: "p", workdir, effort: "medium" })).rejects.toThrow();
    const transcripts = readdirSync(join(workdir, ".tackle", "transcripts"));
    expect(transcripts).toHaveLength(1);
    expect(
      readFileSync(join(workdir, ".tackle", "transcripts", transcripts[0]!), "utf8"),
    ).toContain('"turn.completed"');
  });

  it("captures the diff when the turn changes files", async () => {
    const workdir = makeRepo();
    writeFileSync(join(workdir, "a.txt"), "changed by agent\n"); // simulate the turn's edit
    const adapter = makeAdapter({ fixture: join(fixturesDir, "codex-completed.jsonl") });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.workdirDiff).toContain("+changed by agent");
  });

  it("derives the default authPath from the subprocess HOME", async () => {
    const workdir = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "tackle-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    // auth_mode "apikey" (-> "metered") is deliberately the opposite of whatever
    // this developer's *real* homedir() might contain, so the test only goes
    // green if the adapter actually reads from the fake HOME above rather than
    // from process homedir() -- a real ~/.codex/auth.json with auth_mode
    // "chatgpt" would otherwise make this assertion pass for the wrong reason.
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    writeFileSync(join(home, ".fake-codex.json"), JSON.stringify({ fixture: join(fixturesDir, "codex-completed.jsonl") }));
    const adapter = new CodexAdapter({ baseEnv: { PATH: `${fakesDir}:${process.env.PATH}`, HOME: home } });
    const result = await adapter.run({ prompt: "p", workdir, effort: "medium" });
    expect(result.usage.billingType).toBe("metered");
  });
});
