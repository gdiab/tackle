import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BillingType } from "../types.js";

const execFileAsync = promisify(execFile);

const ENV_KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/**
 * Subscription-before-API, fail closed. Cost fields in the -p result are NOT a
 * billing signal (subscription runs still report total_cost_usd); the credential
 * store's claudeAiOauth.subscriptionType is the probe (verified live 2026-07-02).
 */
export async function detectBillingType(opts: {
  env: Record<string, string>;
  readCredentials: () => Promise<string | null>;
}): Promise<BillingType> {
  if (ENV_KEY_NAMES.some((k) => (opts.env[k] ?? "") !== "")) return "metered";

  let raw: string | null;
  try {
    raw = await opts.readCredentials();
  } catch {
    return "unknown";
  }
  if (raw === null) return "unknown";

  let subscriptionType: unknown;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { subscriptionType?: unknown } };
    subscriptionType = parsed.claudeAiOauth?.subscriptionType;
  } catch {
    return "unknown";
  }
  return typeof subscriptionType === "string" && subscriptionType !== "" ? "subscription" : "unknown";
}

/** macOS keeps Claude Code credentials in the Keychain; elsewhere it's a dotfile. */
export function defaultCredentialsReader(opts: {
  home: string;
  platform?: NodeJS.Platform;
}): () => Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    return async () => {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ]);
        return stdout.trim().length > 0 ? stdout : null;
      } catch {
        return null;
      }
    };
  }
  return async () => {
    try {
      return await readFile(join(opts.home, ".claude", ".credentials.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
}
