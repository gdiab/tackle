import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyConfig, WorkflowState } from "./types.js";
import { DEFAULT_POLICY } from "./types.js";

const STATE_FILE = ".tackle/workflow.json";
const CONFIG_FILE = ".tackle/config.json";

async function readJsonIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readWorkflowState(workdir: string): Promise<WorkflowState | null> {
  const raw = await readJsonIfExists(join(workdir, STATE_FILE));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${STATE_FILE} is not valid JSON; fix or delete it to reset the workflow`);
  }
  const state = parsed as WorkflowState;
  if (state.version !== 1) throw new Error(`unsupported ${STATE_FILE} version; expected 1`);
  return state;
}

export async function writeWorkflowState(workdir: string, state: WorkflowState): Promise<void> {
  await mkdir(join(workdir, ".tackle"), { recursive: true });
  await writeFile(join(workdir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export async function loadPolicyConfig(workdir: string): Promise<PolicyConfig> {
  const raw = await readJsonIfExists(join(workdir, CONFIG_FILE));
  if (raw === null) return { ...DEFAULT_POLICY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  return { ...DEFAULT_POLICY, ...(parsed as Partial<PolicyConfig>) };
}
