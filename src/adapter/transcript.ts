import { randomBytes } from "node:crypto";

/**
 * Timestamp-based transcript filename with a short random suffix. The
 * timestamp alone is only millisecond-precise, so two turns landing in the
 * same millisecond would otherwise collide (one silently overwriting or
 * interleaving with the other); the suffix makes every call's result unique.
 */
export function transcriptFilename(adapterName: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  return `${ts}-${suffix}-${adapterName}.${ext}`;
}
