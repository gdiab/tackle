import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FixtureSpec {
  manifest: Record<string, unknown>;
  seed?: Record<string, string>;
}

/** Write evals/fixtures/<name>/ (manifest.json + optional seed files) under workdir. Returns the fixture dir. */
export async function makeFixture(workdir: string, name: string, spec: FixtureSpec): Promise<string> {
  const dir = join(workdir, "evals", "fixtures", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(spec.manifest, null, 2) + "\n");
  for (const [rel, content] of Object.entries(spec.seed ?? {})) {
    const path = join(dir, "seed", rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

/** A minimal valid manifest with overridable fields. */
export function manifestFor(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: "test fixture",
    prompt: "do the thing",
    effort: "low",
    timeoutSeconds: 60,
    expectations: [{ kind: "status", equals: "completed" }],
    ...overrides,
  };
}
