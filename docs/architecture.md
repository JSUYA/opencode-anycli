# Architecture

OpenCode-AnyCLI adapts opencode model requests to a local coding CLI. The same
provider package drives three flavors, selected by the `cli` provider option:
`cline` (default), `claude`, and `codex`. cline can run via NDJSON subprocess or
`--acp`; claude and codex run as subprocess stream-json sessions
(`cli-profiles.ts` builds their argv + parses their JSON, `stream-json-runner.ts`
is the shared subprocess engine). All flavors emit the same internal
`StreamEvent` shape, so `language-model.ts` maps them to opencode the same way.

## Flow

```text
opencode
  -> provider-cline-cli
  -> child_process.spawn("cline", ["--json", "--yolo", "--act", prompt])
  -> cline NDJSON events
  -> final assistant text back to opencode
```

## Subprocess Mode

Subprocess mode is the default. It keeps cline as the model caller and tool runner. The adapter flattens AI SDK messages into one prompt, starts cline, reads NDJSON lines, forwards cline's visible reasoning/text/output events, reports token/cache usage from cline events or persisted task state, and returns Vercel AI SDK v3-compatible results.

When the flattened prompt is too large for a safe argv handoff, the adapter writes it to a private temp file and sends cline a small wrapper prompt that asks it to read the file. This avoids Ubuntu/Linux `E2BIG` failures caused by the kernel's per-argument size limit.

## ACP Mode

ACP mode is implemented as an opt-in transport. It starts `cline --acp`, opens an Agent Client Protocol session over stdio JSON-RPC, sends the prompt as protocol content, and translates ACP message/tool updates back into opencode stream events.

## Passthrough Mode

Passthrough mode is planned. It would read cline configuration and call the configured model directly from opencode. This can be faster, but it depends on cline's settings schema and does not use cline's own tools.

## opencode-call protocol

cline runs its own internal tool loop and never natively calls opencode's
host-side tools, so out of the box opencode skills and subagent dispatch
appear dead even when the system prompt advertises them. The adapter
teaches cline a small protocol to call back into opencode:

```
<opencode-call name="task">{"subagent_type":"<agent>","description":"<3-5 words>","prompt":"<text>"}</opencode-call>
<opencode-call name="skill">{"name":"<skill-name>"}</opencode-call>
```

When `options.tools` (the V3 tool list opencode passes per turn) contains
`task` and/or `skill`, the adapter appends a compact `OPENCODE_CALL_PROTOCOL`
section (~400 bytes) to the cline handoff. cline emits the tag inside its
normal text stream; the adapter parses the tag, strips it from the visible
text, and forwards it to opencode as a `tool-call` part with finishReason
`tool-calls`. opencode dispatches the call, the result lands as a
`tool-result` on the next turn, and the cline subprocess sees it in
`TOOL_OBSERVATIONS`.

Per-agent permission: opencode auto-enables `task` for primary agents, but
`skill` is opt-in. To make the orchestrator (or any primary agent) able to
load skills, add `skill: true` to the agent's `tools` whitelist in
`~/.config/opencode-anycli/opencode/agents/<agent>.md`:

```yaml
---
name: orchestrator
tools:
  bash: true
  read: true
  grep: true
  task: true
  skill: true
---
```

Skipped silently when `options.tools` carries neither `task` nor `skill`
(title / summary / compaction calls): zero bytes added, zero parser cost.

## Tradeoff

The subprocess design is conservative. It is slower because opencode delegates to another agent loop, but it is easier to maintain across cline updates and avoids duplicating model credentials.
