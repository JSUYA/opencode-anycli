# Architecture

OpenCode-AnyCLI adapts opencode model requests to the local cline CLI.

## Flow

```text
opencode
  -> provider-cline-cli
  -> flatten AI SDK messages into one prompt
  -> cline via subprocess mode or ACP mode
  -> normalize cline events into opencode stream parts
  -> final assistant text and usage back to opencode
```

## Subprocess Mode

Subprocess mode is the default. It keeps cline as the model caller and tool runner. The adapter flattens AI SDK messages into one prompt, starts cline, reads NDJSON lines, forwards cline's visible reasoning/text/output events, reports token/cache usage from cline events or persisted task state, and returns Vercel AI SDK v3-compatible results.

When the flattened prompt is too large for a safe argv handoff, the adapter writes it to a private temp file and sends cline a small wrapper prompt that asks it to read the file. This avoids Ubuntu/Linux `E2BIG` failures caused by the kernel's per-argument size limit.

## ACP Mode

ACP mode is implemented as an opt-in transport. It starts `cline --acp`, opens
an Agent Client Protocol session over stdio JSON-RPC, sends the prompt as
protocol content, and translates ACP message/tool updates back into opencode
stream events.

## Tradeoff

The design keeps cline as the model caller instead of duplicating model
credentials in opencode. Subprocess mode is slower because opencode delegates to
another agent loop, but it is the most compatible path. ACP is available for
users who want the structured cline transport.
