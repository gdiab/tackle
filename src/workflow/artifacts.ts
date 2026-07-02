import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Read a phase artifact; null means "missing or blank", which gates treat identically. */
export async function readArtifact(workdir: string, relPath: string): Promise<string | null> {
  try {
    const content = await readFile(join(workdir, relPath), "utf8");
    return content.trim().length > 0 ? content : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function removeArtifact(workdir: string, relPath: string): Promise<void> {
  await rm(join(workdir, relPath), { force: true });
}
