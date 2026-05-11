# Troubleshooting

Start with:

```bash
opencode-anycli --doctor
```

## opencode-anycli Command Not Found

Open a new terminal or source the shell rc file that `install.sh` updated:

```bash
source ~/.zshrc
# or, for bash:
source ~/.bashrc
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

Rebuild through the installer so the config and plugin paths stay aligned:

```bash
./install.sh --rebuild
```

For package development, `npm install --workspaces --include-workspace-root`
and `npm run build` are still valid, but they do not rewrite installed config.

## Permission Problems After Elevated Runs

If a previous `--allow-dangerously-skip-permissions` session left root-owned
files under opencode, cline, or npm cache directories, run:

```bash
opencode-anycli --fix
```

## Slow Responses

Subprocess mode delegates from opencode to cline, so responses can take longer than a direct model call. Use clear prompts and keep tasks scoped.

## NDJSON Parse Warnings

Unknown cline event lines are ignored unless they are known user-visible reasoning/text/output events. Run with `DEBUG=1` to inspect events.

## Missing Usage

OpenCode-AnyCLI reads token usage from cline JSON events first. If the cline CLI omits final usage updates from stdout, the provider falls back to `~/.cline/data/tasks/<taskId>/ui_messages.json`.
