import { randomBytes } from "node:crypto";

/**
 * Monotonic per-process counter, encoded in base36 for compactness. Guarantees
 * every call within this process produces a distinct filename, even when the
 * timestamp and random suffix are both identical to a prior call (e.g. two
 * calls in the same millisecond with a colliding random draw).
 */
let callCounter = 0;

/**
 * Timestamp-based transcript filename with an in-process monotonic counter
 * and a short random suffix. The timestamp alone is only millisecond-precise,
 * so two turns landing in the same millisecond would otherwise collide (one
 * silently overwriting or interleaving with the other); the counter
 * guarantees in-process uniqueness deterministically, and the random suffix
 * additionally guards against cross-process collisions in the same
 * millisecond.
 */
export function transcriptFilename(adapterName: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const counter = (callCounter++).toString(36);
  const suffix = randomBytes(3).toString("hex");
  return `${ts}-${counter}${suffix}-${adapterName}.${ext}`;
}
