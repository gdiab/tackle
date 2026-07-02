import { describe, expect, it } from "vitest";
import { AdapterEnvError, buildAdapterEnv } from "../src/adapter/env.js";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/g",
  ANTHROPIC_API_KEY: "sk-leak",
  OPENAI_API_KEY: "sk-leak2",
  RANDOM_SECRET: "shh",
};

describe("buildAdapterEnv", () => {
  it("includes only allowlisted keys from base", () => {
    const env = buildAdapterEnv({ base, allow: ["PATH", "HOME"] });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/g" });
  });

  it("skips allowlisted keys that are undefined in base", () => {
    const env = buildAdapterEnv({ base: { PATH: "/usr/bin", HOME: undefined }, allow: ["PATH", "HOME"] });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("merges extra keys", () => {
    const env = buildAdapterEnv({ base, allow: ["PATH"], extra: { FAKE_CODEX_FIXTURE: "/f.jsonl" } });
    expect(env).toEqual({ PATH: "/usr/bin", FAKE_CODEX_FIXTURE: "/f.jsonl" });
  });

  it("throws when an extra key collides with an allowlisted base key", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH"], extra: { PATH: "/evil" } })).toThrow(AdapterEnvError);
  });

  it("throws when a banned key is allowlisted", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH", "ANTHROPIC_API_KEY"] })).toThrow(AdapterEnvError);
  });

  it("throws when a banned key arrives via extra", () => {
    expect(() => buildAdapterEnv({ base, allow: ["PATH"], extra: { OPENAI_API_KEY: "x" } })).toThrow(AdapterEnvError);
  });
});
