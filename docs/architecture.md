# Architecture

openclineclicode adapts opencode model requests to the local cline CLI.

## Flow

```text
opencode
  -> provider-cline-cli
  -> child_process.spawn("cline", ["--json", "--yolo", "--act", prompt])
  -> cline NDJSON events
  -> final assistant text back to opencode
```

## Subprocess Mode

Subprocess mode is the implemented default. It keeps cline as the model caller and tool runner. The adapter flattens AI SDK messages into one prompt, starts cline, reads NDJSON lines, extracts final text, and returns Vercel AI SDK v3-compatible results.

## Passthrough Mode

Passthrough mode is planned. It would read cline configuration and call the configured model directly from opencode. This can be faster, but it depends on cline's settings schema and does not use cline's own tools.

## Tradeoff

The subprocess design is conservative. It is slower because opencode delegates to another agent loop, but it is easier to maintain across cline updates and avoids duplicating model credentials.
