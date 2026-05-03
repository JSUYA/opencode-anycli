# Troubleshooting

Start with:

```bash
openclineclicode --doctor
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

Unknown cline event lines are ignored unless they affect final text extraction. Run with `DEBUG=1` to inspect events.
