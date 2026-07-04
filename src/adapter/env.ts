export const BANNED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_KEY",
] as const;

export class AdapterEnvError extends Error {}

export function buildAdapterEnv(opts: {
  base: Record<string, string | undefined>;
  allow: string[];
  extra?: Record<string, string>;
}): Record<string, string> {
  const banned = new Set<string>(BANNED_ENV_KEYS);
  // Null-prototype object: a plain `{}` treats a "__proto__" key specially
  // (the legacy accessor silently swallows non-object assignments instead of
  // creating an own property), which would drop that key even though it
  // passes the collision check below. With no prototype, "__proto__" is just
  // an ordinary own key like any other.
  const env: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const key of opts.allow) {
    if (banned.has(key)) {
      throw new AdapterEnvError(`banned env key allowlisted: ${key}`);
    }
    const value = opts.base[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (banned.has(key)) {
      throw new AdapterEnvError(`banned env key in extra: ${key}`);
    }
    if (Object.hasOwn(env, key)) {
      throw new AdapterEnvError(`extra env key collides with allowlisted base key: ${key}`);
    }
    env[key] = value;
  }

  return env;
}
