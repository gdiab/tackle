import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  title: string;
  /** Path the human should open and read before deciding. */
  artifactPath: string;
  /** The turn's model-written summary ("" when unknown). */
  summary: string;
  detail?: string;
}

// SPEC.md "Gate semantics": the needs-human-decision presenter is abstracted so
// a later adapter can route it to a notification or an editor; v1 is stdout
// because the operator is present (attended-first).
export interface Presenter {
  askApproval(req: ApprovalRequest): Promise<boolean>;
  inform(message: string): void;
}

export class TerminalPresenter implements Presenter {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  inform(message: string): void {
    this.output.write(message + "\n");
  }

  async askApproval(req: ApprovalRequest): Promise<boolean> {
    this.inform(`\n== ${req.title} ==`);
    this.inform(`artifact: ${req.artifactPath}`);
    if (req.summary.length > 0) this.inform(`summary: ${req.summary}`);
    if (req.detail !== undefined) this.inform(req.detail);
    const rl = createInterface({ input: this.input, output: this.output });
    try {
      const answer = (await rl.question("approve? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }
}
