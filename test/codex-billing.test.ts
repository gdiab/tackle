import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectBillingType } from "../src/adapter/codex/billing.js";

function authFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tackle-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, contents);
  return path;
}

describe("detectBillingType", () => {
  it("reports subscription for chatgpt auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("subscription");
  });

  it("reports metered for apikey auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("metered");
  });

  it("env API key overrides subscription auth (credential precedence)", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "chatgpt" }));
    expect(await detectBillingType({ env: { OPENAI_API_KEY: "sk-x" }, authPath: path })).toBe("metered");
  });

  it("ignores empty-string env keys (not a credential)", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "chatgpt" }));
    expect(await detectBillingType({ env: { OPENAI_API_KEY: "" }, authPath: path })).toBe("subscription");
  });

  it("reports unknown when auth.json is missing", async () => {
    expect(await detectBillingType({ env: {}, authPath: "/nonexistent/auth.json" })).toBe("unknown");
  });

  it("reports unknown for unrecognized auth_mode", async () => {
    const path = authFile(JSON.stringify({ auth_mode: "device" }));
    expect(await detectBillingType({ env: {}, authPath: path })).toBe("unknown");
  });
});
