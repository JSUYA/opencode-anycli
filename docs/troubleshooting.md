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

## ACP Turn Aborts With "stalled … deadlocked"

In ACP mode the provider runs a health watchdog. If cline produces **no ACP
output** for the silence window (default **300s**), the watchdog samples the
cline process subtree's CPU **and** I/O; it aborts the turn only when *neither*
advanced (process gone, zombie, or truly wedged). The error reads:

```
cline --acp stalled with no output for 300s and no CPU or I/O progress (deadlocked); …
```

Two things legitimately produce a long silent, near-idle stretch and are handled:

- **A remote model with a slow first token** (e.g. a cold/queued Gauss server —
  TTFT of a minute or more has been observed). The process just blocks on a
  socket: zero CPU, zero I/O. Only the *window* protects this — raise it if your
  model is slow:

  ```bash
  export OPENCODE_ANYCLI_ACP_IDLE_MS=600000   # 10 min
  ```

- **cline reading/rewriting a bloated task-history file.** cline-sr persists all
  task history to `~/.cline-sr/data/state/taskHistory.json` and reads + atomically
  rewrites the whole file **every turn**. Left unchecked it grows to tens of MB,
  adding seconds of I/O to each turn (and, when a turn was killed mid-write by the
  old 90s watchdog, leaving `taskHistory.json.tmp.*.json` orphans that make the
  next turn worse). If turns are slow or aborting, check its size and reset it:

  ```bash
  du -h ~/.cline-sr/data/state/taskHistory.json
  ls  ~/.cline-sr/data/state/taskHistory.json.tmp.*.json 2>/dev/null   # orphaned writes
  # archive (reversible) + clear orphans; cline recreates a fresh, small file:
  mv ~/.cline-sr/data/state/taskHistory.json ~/.cline-sr/taskHistory-backup-$(date +%s).json
  rm -f ~/.cline-sr/data/state/taskHistory.json.tmp.*.json
  ```

The I/O part of the progress metric means a turn that is actively reading/writing
that file (or streaming from the model) is **not** mistaken for a deadlock; the
window default was raised from 90s to 300s so a slow-but-healthy first turn is not
cut off. A genuine deadlock still hangs with zero CPU and zero I/O and is
recovered after the window elapses.

## NDJSON Parse Warnings

Unknown cline event lines are ignored unless they are known user-visible reasoning/text/output events. Run with `DEBUG=1` to inspect events.

## Missing Usage

OpenCode-AnyCLI reads token usage from cline JSON events first. If the cline CLI omits final usage updates from stdout, the provider falls back to `~/.cline/data/tasks/<taskId>/ui_messages.json`.
