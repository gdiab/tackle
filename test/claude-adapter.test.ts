import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapter/claude/index.js";

const fakesDir = resolve("test/fakes");

const SUB_CREDS = JSON.stringify({ claudeAiOauth: { subscriptionType: "pro" } });

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

function makeEnv(knobs: {
  result?: object;
  exitCode?: number;
  promptFile?: string;
  writeFile?: { path: string; content: string };
  sleepMs?: number;
}): { PATH: string; HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "tackle-home-"));
  writeFileSync(join(home, ".fake-claude.json"), JSON.stringify(knobs));
  return { PATH: `${fakesDir}:${process.env.PATH}`, HOME: home };
}

describe("ClaudeAdapter", () => {
  it("runs a turn and maps the result", async () => {
    const repo = makeRepo();
    const env = makeEnv({});
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const result = await adapter.run({ prompt: "review", workdir: repo, effort: "medium" });

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("ok");
    expect(result.sessionId).toBe("fake-claude-session");
    expect(result.authorship).toEqual({ adapter: "claude-code", model: null, effort: "medium" });
    expect(result.usage.billingType).toBe("subscription");
    expect(result.workdirDiff).toBe(""); // reviewer wrote nothing
    // transcript landed on disk
    expect(result.transcriptRef).toContain(".tackle/transcripts/");
    expect(existsSync(result.transcriptRef)).toBe(true);
  });

  it("sends the prompt via stdin", async () => {
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "tackle-prompt-"));
    const promptFile = join(home, "prompt.txt");
    const env = makeEnv({ promptFile });
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const prompt = "review this diff carefully";
    await adapter.run({ prompt, workdir: repo, effort: "medium" });

    expect(readFileSync(promptFile, "utf8")).toBe(prompt);
  });

  it("reports unknown billing without blocking the turn (the runner gates)", async () => {
    const repo = makeRepo();
    const env = makeEnv({});
    // ANTHROPIC key must NOT be in env (buildAdapterEnv bans it) -- simulate via
    // readCredentials: async () => null -> billingType "unknown"
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => null });
    const result = await adapter.run({ prompt: "p", workdir: repo, effort: "low" });
    expect(result.usage.billingType).toBe("unknown");
  });

  it("maps a nonzero exit to tool_error", async () => {
    const repo = makeRepo();
    const env = makeEnv({ exitCode: 3 });
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const result = await adapter.run({ prompt: "p", workdir: repo, effort: "medium" });
    expect(result.status).toBe("tool_error");
  });

  it("captures a diff when the subprocess writes to the tree", async () => {
    const repo = makeRepo();
    const env = makeEnv({ writeFile: { path: join(repo, "sneaky.ts"), content: "x" } });
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const result = await adapter.run({ prompt: "p", workdir: repo, effort: "medium" });
    expect(result.workdirDiff).toContain("sneaky.ts");
  });

  it("times out a hung subprocess", async () => {
    const repo = makeRepo();
    const env = makeEnv({ sleepMs: 60000 });
    const adapter = new ClaudeAdapter({ baseEnv: env, readCredentials: async () => SUB_CREDS });
    const result = await adapter.run({ prompt: "p", workdir: repo, effort: "medium", timeoutMs: 500 });
    expect(result.status).toBe("timeout");
  });
});
