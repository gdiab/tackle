import type { Effort } from "../types.js";

export interface PrintCommand {
  cmd: string;
  args: string[];
  stdin: string;
}

// The reviewer needs no tools: the diff and requirement are inlined in the
// prompt, and the repo holds artifacts it must not see (.tackle/plan.md — the
// SPEC isolation rule withholds the author's plan from the reviewer).
const DISALLOWED_TOOLS = "Bash,Edit,Write,NotebookEdit,Read,Glob,Grep,Task,WebFetch,WebSearch";

export function buildPrintCommand(req: { prompt: string; effort: Effort; model?: string }): PrintCommand {
  const args = [
    "-p",
    "--output-format",
    "json",
    // no user/project settings: no hooks, plugins, or apiKeyHelper in the review path
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disallowedTools",
    DISALLOWED_TOOLS,
    "--effort",
    req.effort,
  ];
  if (req.model !== undefined) args.push("--model", req.model);
  // prompt via stdin: argv has a ~128KB limit, review prompts embed whole diffs
  return { cmd: "claude", args, stdin: req.prompt };
}
