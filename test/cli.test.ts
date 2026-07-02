import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("cli", () => {
  it("is named tackle and has a version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("tackle");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
