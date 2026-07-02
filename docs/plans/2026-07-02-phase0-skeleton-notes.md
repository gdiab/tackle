# Phase 0 skeleton — real-turn smoke evidence

Date: 2026-07-02 · Task 10 of `2026-07-02-phase0-skeleton.md` · codex-cli 0.142.4 · node v26.0.0

## Command

```bash
pnpm build
SCRATCH=$(mktemp -d /tmp/tackle-smoke-XXXX)   # → /tmp/tackle-smoke-jVNR
cd "$SCRATCH" && git init -q && git commit -q --allow-empty -m init && cd -
node dist/cli.js turn "Create a file named hello.txt containing exactly the word: hello" \
  --cwd /tmp/tackle-smoke-jVNR --effort low --timeout 300
```

## Result (exit code 0)

```json
{
  "status": "completed",
  "workdirDiff": "diff --git a/hello.txt b/hello.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n",
  "transcriptRef": "/tmp/tackle-smoke-jVNR/.tackle/transcripts/2026-07-02T17-44-16-241Z-codex.jsonl",
  "summary": "Created [hello.txt](/private/tmp/tackle-smoke-jVNR/hello.txt) containing exactly `hello`.",
  "sessionId": "019f23ee-5a49-7261-bb6b-eb4df6c6f1f1",
  "authorship": { "adapter": "codex", "model": null, "effort": "low" },
  "usage": {
    "tokens": {
      "inputTokens": 7114,
      "cacheReadInputTokens": 19200,
      "outputTokens": 81,
      "reasoningOutputTokens": 0
    },
    "billingType": "subscription"
  }
}
```

## Verifications

- `hello.txt` exists in the scratch repo containing exactly `hello`; the `workdirDiff` shows the `+hello` new-file hunk — diff-as-artifact-of-record works end to end.
- `transcriptRef` points at a real JSONL file whose first lines are the raw `thread.started` / `turn.started` / `item.completed` stream.
- `usage.billingType: "subscription"` — detected from `~/.codex/auth.json` `auth_mode: "chatgpt"` with an allowlist-built env (`PATH`, `HOME` only), so the SPEC's billing assertion rides in the envelope on a real turn.
- **Step 2 assumptions confirmed live:** `codex exec … -` with the prompt on stdin delivered the prompt intact (the agent created the exact requested file), and `--full-auto` permitted workspace writes. No fallback to argv-prompt or sandbox-flag changes needed.
- Token normalization sane: codex reported `input_tokens: 26314, cached_input_tokens: 19200` → envelope shows `inputTokens: 7114` + `cacheReadInputTokens: 19200` (no double counting).

## Deviations

None. The plan's builder, parser, and status mapping worked against the live CLI unchanged.
