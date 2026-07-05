import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../adapter/diff.js";

/**
 * Seed -> fresh temp git repo: copy seed/ (when present), init, commit.
 * The turn (or replay) runs with this as cwd. Caller removes the dir.
 */
export async function materializeWorkdir(fixtureDir: string): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "tackle-eval-"));
  const seedDir = join(fixtureDir, "seed");
  const hasSeed = await stat(seedDir).then((s) => s.isDirectory()).catch(() => false);
  if (hasSeed) await cp(seedDir, workdir, { recursive: true });
  await git(workdir, ["init", "-q"]);
  await git(workdir, ["config", "user.name", "tackle-eval"]);
  await git(workdir, ["config", "user.email", "tackle-eval@local"]);
  await git(workdir, ["add", "-A"]);
  await git(workdir, ["commit", "-q", "--allow-empty", "-m", "seed"]);
  return workdir;
}

/** Reconstruct a recorded run's tree: apply its workdirDiff onto a fresh materialization. */
export async function applyRecordedDiff(workdir: string, diff: string): Promise<void> {
  if (diff.length === 0) return;
  const patchDir = await mkdtemp(join(tmpdir(), "tackle-eval-patch-"));
  const patchFile = join(patchDir, "run.patch");
  try {
    await writeFile(patchFile, diff);
    await git(workdir, ["apply", "--whitespace=nowarn", patchFile]);
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }
}
