import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(workdir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workdir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function resolveHead(workdir: string): Promise<string> {
  return (await git(workdir, ["rev-parse", "HEAD"])).trim();
}

export async function captureWorkdirDiff(workdir: string, baseRef: string): Promise<string> {
  const tracked = await git(workdir, ["diff", baseRef]);

  const untrackedList = (await git(workdir, ["ls-files", "-z", "--others", "--exclude-standard"]))
    .split("\0")
    .filter((f) => f.length > 0);

  const untrackedDiffs: string[] = [];
  for (const file of untrackedList) {
    // git diff --no-index exits 1 when files differ; that is the expected case
    const diff = await git(workdir, ["diff", "--no-index", "--", "/dev/null", file]).catch(
      (err: { code?: number; stdout?: string }) => {
        if (err.code === 1 && typeof err.stdout === "string" && err.stdout.length > 0)
          return err.stdout;
        throw err;
      },
    );
    untrackedDiffs.push(diff);
  }

  return [tracked, ...untrackedDiffs].filter((d) => d.length > 0).join("");
}
