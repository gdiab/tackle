import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCredentialsReader, detectBillingType } from "../src/adapter/claude/billing.js";

const subCreds = JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } });

describe("claude billing detection", () => {
  it("reports metered when an Anthropic key env var is set", async () => {
    expect(
      await detectBillingType({ env: { ANTHROPIC_API_KEY: "sk-x" }, readCredentials: async () => subCreds }),
    ).toBe("metered");
    expect(
      await detectBillingType({ env: { ANTHROPIC_AUTH_TOKEN: "t" }, readCredentials: async () => subCreds }),
    ).toBe("metered");
  });

  it("ignores empty-string key env vars", async () => {
    expect(
      await detectBillingType({ env: { ANTHROPIC_API_KEY: "" }, readCredentials: async () => subCreds }),
    ).toBe("subscription");
  });

  it("reports subscription when the credential store names a subscription type", async () => {
    expect(await detectBillingType({ env: {}, readCredentials: async () => subCreds })).toBe("subscription");
  });

  it("fails closed to unknown on missing, unreadable, or malformed credentials", async () => {
    expect(await detectBillingType({ env: {}, readCredentials: async () => null })).toBe("unknown");
    expect(
      await detectBillingType({
        env: {},
        readCredentials: async () => {
          throw new Error("keychain locked");
        },
      }),
    ).toBe("unknown");
    expect(await detectBillingType({ env: {}, readCredentials: async () => "not json" })).toBe("unknown");
    expect(await detectBillingType({ env: {}, readCredentials: async () => "{}" })).toBe("unknown");
    expect(
      await detectBillingType({
        env: {},
        readCredentials: async () => JSON.stringify({ claudeAiOauth: { subscriptionType: "" } }),
      }),
    ).toBe("unknown");
  });

  it("defaultCredentialsReader reads ~/.claude/.credentials.json on non-darwin", async () => {
    const home = await mkdtemp(join(tmpdir(), "tackle-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), subCreds);
    const read = defaultCredentialsReader({ home, platform: "linux" });
    expect(await read()).toBe(subCreds);
  });

  it("defaultCredentialsReader returns null when the file is absent (non-darwin)", async () => {
    const home = await mkdtemp(join(tmpdir(), "tackle-home-"));
    const read = defaultCredentialsReader({ home, platform: "linux" });
    expect(await read()).toBeNull();
  });
});
