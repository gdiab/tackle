import type { Effort } from "../types.js";

export interface PrintCommand {
  cmd: string;
  args: string[];
  stdin: string;
}

export function buildPrintCommand(req: {
  prompt: string;
  effort: Effort;
  model?: string;
  resumeSessionId?: string;
}): PrintCommand {
  const args = req.resumeSessionId ? ["exec", "resume", req.resumeSessionId] : ["exec"];

  args.push("--json", "--full-auto", "--skip-git-repo-check");
  args.push("-c", `model_reasoning_effort="${req.effort}"`);
  if (req.model !== undefined) args.push("-m", req.model);
  args.push("-"); // read prompt from stdin: argv has a ~128KB limit, prompts don't

  return { cmd: "codex", args, stdin: req.prompt };
}
