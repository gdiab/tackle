import { createHash } from "node:crypto";

/** Hex sha256 of a UTF-8 string — the pin format for approved artifacts and frozen diffs. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
