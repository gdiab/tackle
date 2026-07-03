import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifact, removeArtifact } from "../src/workflow/artifacts.js";
import { loadPolicyConfig, readWorkflowState, writeWorkflowState } from "../src/workflow/state.js";
import type { WorkflowState } from "../src/workflow/types.js";
import { DEFAULT_POLICY } from "../src/workflow/types.js";

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tackle-wf-"));
}

describe("workflow state", () => {
  it("returns null when no state file exists", async () => {
    expect(await readWorkflowState(await tempWorkdir())).toBeNull();
  });

  it("round-trips workflow state through .tackle/workflow.json", async () => {
    const dir = await tempWorkdir();
    const state: WorkflowState = {
      version: 1,
      request: "add a widget",
      entry: "specs",
      phases: { specs: { status: "approved" } },
    };
    await writeWorkflowState(dir, state);
    expect(await readWorkflowState(dir)).toEqual(state);
  });

  it("throws a readable error on corrupt state", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "workflow.json"), "{not json");
    await expect(readWorkflowState(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an unknown state version", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "workflow.json"), JSON.stringify({ version: 2 }));
    await expect(readWorkflowState(dir)).rejects.toThrow(/version/);
  });

  it("throws a readable error when the state file parses to something other than an object", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "workflow.json"), "null");
    await expect(readWorkflowState(dir)).rejects.toThrow(/fix or delete it to reset the workflow/);
  });
});

describe("policy config", () => {
  it("returns defaults when no config file exists", async () => {
    expect(await loadPolicyConfig(await tempWorkdir())).toEqual(DEFAULT_POLICY);
  });

  it("merges overrides from .tackle/config.json over defaults", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 0 }));
    const policy = await loadPolicyConfig(dir);
    expect(policy.deterministicRetries).toBe(0);
    expect(policy.reviewLoopIterations).toBe(DEFAULT_POLICY.reviewLoopIterations);
  });

  it("throws a readable error when config.json parses to something other than an object", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify("nope"));
    await expect(loadPolicyConfig(dir)).rejects.toThrow(/must contain a JSON object/);
  });

  it("throws a readable error naming the key when deterministicRetries is negative", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: -5 }));
    await expect(loadPolicyConfig(dir)).rejects.toThrow(/deterministicRetries/);
  });

  it("throws a readable error naming the key when a policy value is a non-numeric string", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: "never" }));
    await expect(loadPolicyConfig(dir)).rejects.toThrow(/reviewLoopIterations/);
  });

  it("throws a readable error when a policy value is a non-integer float", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 1.5 }));
    await expect(loadPolicyConfig(dir)).rejects.toThrow(/deterministicRetries/);
  });

  it("throws when circuitBreakerThreshold is 0 (must be >= 1)", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ circuitBreakerThreshold: 0 }));
    await expect(loadPolicyConfig(dir)).rejects.toThrow(/circuitBreakerThreshold/);
  });

  it("loads a valid config with all three keys set", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(
      join(dir, ".tackle", "config.json"),
      JSON.stringify({ deterministicRetries: 3, reviewLoopIterations: 5, circuitBreakerThreshold: 2 }),
    );
    const policy = await loadPolicyConfig(dir);
    expect(policy).toEqual({ deterministicRetries: 3, reviewLoopIterations: 5, circuitBreakerThreshold: 2 });
  });

  it("defaults keys absent from the config file", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 3 }));
    const policy = await loadPolicyConfig(dir);
    expect(policy.deterministicRetries).toBe(3);
    expect(policy.reviewLoopIterations).toBe(DEFAULT_POLICY.reviewLoopIterations);
    expect(policy.circuitBreakerThreshold).toBe(DEFAULT_POLICY.circuitBreakerThreshold);
  });
});

describe("artifacts", () => {
  it("reads a non-empty artifact", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "# specs\n");
    expect(await readArtifact(dir, ".tackle/specs.md")).toBe("# specs\n");
  });

  it("returns null for a missing artifact", async () => {
    expect(await readArtifact(await tempWorkdir(), ".tackle/specs.md")).toBeNull();
  });

  it("returns null for a whitespace-only artifact", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "  \n\n");
    expect(await readArtifact(dir, ".tackle/specs.md")).toBeNull();
  });

  it("removeArtifact deletes and is idempotent", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "specs.md"), "x");
    await removeArtifact(dir, ".tackle/specs.md");
    await removeArtifact(dir, ".tackle/specs.md"); // second call must not throw
    expect(await readArtifact(dir, ".tackle/specs.md")).toBeNull();
  });
});
