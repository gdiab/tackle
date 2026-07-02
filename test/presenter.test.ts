import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalPresenter } from "../src/workflow/presenter.js";

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString("utf8");
}

describe("TerminalPresenter", () => {
  it("approves on y", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({
      title: "specs phase awaiting approval",
      artifactPath: ".tackle/specs.md",
      summary: "wrote the spec",
    });
    input.write("y\n");
    expect(await pending).toBe(true);
    const shown = read();
    expect(shown).toContain("specs phase awaiting approval");
    expect(shown).toContain(".tackle/specs.md");
    expect(shown).toContain("wrote the spec");
  });

  it("treats anything but y/yes as decline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({ title: "t", artifactPath: "a", summary: "" });
    input.write("\n"); // bare enter = decline (default N)
    expect(await pending).toBe(false);
  });

  it("shows detail when given", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);
    const presenter = new TerminalPresenter(input, output);
    const pending = presenter.askApproval({
      title: "t",
      artifactPath: "a",
      summary: "",
      detail: "frozen diff: .tackle/build.diff",
    });
    input.write("yes\n");
    expect(await pending).toBe(true);
    expect(read()).toContain("frozen diff: .tackle/build.diff");
  });

  it("inform writes a line to the output stream", () => {
    const output = new PassThrough();
    const read = collect(output);
    new TerminalPresenter(new PassThrough(), output).inform("hello");
    expect(read()).toBe("hello\n");
  });
});
