# Troubleshooting

Start with:

```bash
opencode-anycli --doctor
```

## cline Returns No Text

Run cline directly:

```bash
cline --json --yolo --act "say hi"
```

If this does not produce final text, fix the cline setup first.

## opencode Not Found

Install opencode and make sure its binary directory is on `PATH`:

```bash
npm install -g opencode-ai
opencode --version
```

## cline Not Found

Install cline and run it once:

```bash
npm install -g cline
cline
```

## Provider Dist Missing

Build the workspace again:

```bash
npm install --workspaces --include-workspace-root
npm run build
```

## Slow Responses

Subprocess mode delegates from opencode to cline, so responses can take longer than a direct model call. Use clear prompts and keep tasks scoped.

## NDJSON Parse Warnings

Unknown cline event lines are ignored unless they are known user-visible reasoning/text/output events. Run with `DEBUG=1` to inspect events.

## Missing Usage

OpenCode-AnyCLI reads token usage from cline JSON events first. If the cline CLI omits final usage updates from stdout, the provider falls back to `~/.cline/data/tasks/<taskId>/ui_messages.json`.

## Infinite Loop Prevention

OpenCode-AnyCLI includes several mechanisms to prevent infinite loops between opencode and cline:

### Built-in Protections

1. **Skill Bypass Loop Guard**: Prevents the same skill from being dispatched multiple times by checking if it was already executed in the conversation history.

2. **Tool-call Deduplication**: Tracks tool-call signatures (toolName + input) and filters out duplicates that could indicate a loop.

3. **Max Turns Limit**: Automatically stops after 15 tool-call turns by default. Override with `OPENCODE_ANYCLI_MAX_TURNS` environment variable:
   ```bash
   export OPENCODE_ANYCLI_MAX_TURNS=30
   ```

4. **ACP Message Deduplication**: cline's ACP emits assistant messages twice (token-by-token + full result). The provider deduplicates these to avoid repetition.

### Debugging Loop Issues

If you suspect an infinite loop:

1. **Enable debug logging**:
   ```bash
   DEBUG=1 opencode-anycli "your prompt"
   ```

2. **Log raw NDJSON stream** for analysis:
   ```bash
   OPENCODE_ANYCLI_NDJSON_LOG=/tmp/opencode-ndjson.log opencode-anycli "your prompt"
   ```

3. **Log prompt handoff** to see what's sent to cline:
   ```bash
   OPENCODE_ANYCLI_PROMPTLOG=/tmp/opencode-prompt.log opencode-anycli "your prompt"
   ```

4. **Log usage mapping** for token diagnostics:
   ```bash
   OPENCODE_ANYCLI_USAGELOG=/tmp/opencode-usage.log opencode-anycli "your prompt"
   ```

### Common Loop Causes

- **Skill not loading**: Custom cline builds may ignore skill directives. The provider intercepts these and emits `skill` tool-calls directly.
- **Tool-call regeneration**: cline generates the same tool-call after receiving tool-result. Deduplication filters these.
- **Long conversations**: The 400-byte guard distance was increased to 2000 bytes to handle longer tool-results between dispatches.
