import { readFile } from "node:fs/promises";
import type { BillingType } from "../types.js";

const ENV_KEY_NAMES = ["OPENAI_API_KEY", "OPENAI_KEY"];

export async function detectBillingType(opts: {
  env: Record<string, string>;
  authPath: string;
}): Promise<BillingType> {
  if (ENV_KEY_NAMES.some((k) => opts.env[k] !== undefined)) return "metered";

  let authMode: unknown;
  try {
    const raw = JSON.parse(await readFile(opts.authPath, "utf8")) as { auth_mode?: unknown };
    authMode = raw.auth_mode;
  } catch {
    return "unknown";
  }

  if (authMode === "chatgpt") return "subscription";
  if (authMode === "apikey") return "metered";
  return "unknown";
}
