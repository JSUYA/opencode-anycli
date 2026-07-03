# Configuration

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode-anycli/opencode/opencode.json` | opencode configuration and adapter registration. |
| `~/.config/opencode-anycli/opencode/AGENTS.md` | Default agent instructions. |
| `~/.config/opencode-anycli/opencode/{commands,agents,skills}/` | Optional extensions installed by Oh-My-AnyCLI. |
| `~/.cline/data/globalState.json` | cline-managed model settings. |
| `~/.cline/data/secrets.json` | cline-managed secrets when present. |

The CLI sets `XDG_CONFIG_HOME=$HOME/.config/opencode-anycli` when starting opencode. To override that wrapper-private XDG directory, set `OPENCODE_ANYCLI_XDG`.

## Providers and models

The bundled config registers three CLI-backed providers. Pick any of them in
opencode's model picker as `provider/model`:

| Provider | Model id | Backing CLI | Model · effort |
| --- | --- | --- | --- |
| `cline` | `GaussO4.1-CLI` / `GaussO3.3-CLI` | `cline` | passed to cline as `-m <model>` |
| `claude` | `opus-4.8-high` / `opus-4.8-xhigh` / `opus-4.8-max` / `sonnet-high` / `sonnet-xhigh` / `sonnet-max` | `claude` | Opus 4.8 or Sonnet · high/xhigh/max |
| `codex` | `gpt-5.4-high` / `gpt-5.4-xhigh` / `gpt-5.5-high` / `gpt-5.5-xhigh` | `codex` | GPT-5.4 or GPT-5.5 · high/xhigh |

`claude` and `codex` reuse the OAuth login already stored by those CLIs — no
keys are copied into opencode. They run as subprocess stream-json sessions
(`claude -p --output-format stream-json`, `codex exec --json`) because neither
binary ships a native `--acp` transport. The reasoning effort is taken from the
model id suffix, and yolo permission bypass is applied automatically per CLI
(`--permission-mode bypassPermissions` for claude,
`--dangerously-bypass-approvals-and-sandbox` for codex), matching cline's
always-on `--yolo`.

## Provider Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `cli` | `cline`, `claude`, or `codex` | `cline` | Which locally-installed CLI this provider drives. |
| `mode` | `subprocess`, `acp`, or `passthrough` | `subprocess` | cline only. `passthrough` is not implemented yet. |
| `command` | string | the `cli` name | Path to the CLI binary. |
| `extraArgs` | string array | `[]` | Additional CLI arguments (appended after the flavor's own flags). |
| `cwd` | string | opencode working directory | Optional working directory override. |
| `timeoutMs` | number | `3600000` | Subprocess timeout. |
| `env` | object | `{}` | Extra environment variables for the CLI. |

## cline version

The wrapper is tuned for **cline 0.5.1**, the build that ships the `--acp`
transport (larger context, structured tool updates). On session start a TUI
toast reports the detected cline version, and on exit the wrapper prints a
one-line status:

- On 0.5.1: `cline 0.5.1 — optimized build (ACP enabled). ✓`
- On any other version: a note that ACP is disabled (subprocess fallback) plus
  the reinstall guide:

  ```
  npm uninstall -g cline
  npm install -g cline@0.5.1 --registry https://bart.sec.samsung.net/artifactory/api/npm/coding-assistant-npm-remote/
  ```

The startup toast is provided by the `cline-version-notify` plugin, installed to
`~/.config/opencode-anycli/opencode/plugin/` and registered in the config
`plugin[]` array by `install.sh`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `OPENCODE_ANYCLI_CLINE_BIN` | Override the cline binary path. |
| `OPENCODE_ANYCLI_CONFIG` | Override the opencode config path. |
| `OPENCODE_ANYCLI_XDG` | Override the wrapper-private XDG config directory passed to opencode. |
| `OPENCODE_ANYCLI_AUTO_APPROVE=1` | Allow all opencode permissions for the spawned session. |
| `OPENCODE_ANYCLI_TTY=0` | Disable the default inherited stdin for cline subprocesses. |
| `OPENCODE_ANYCLI_DANGEROUS=1` | Re-exec the session under `sudo -E`; same as `--allow-dangerously-skip-permissions`. |
| `OPENCODE_ANYCLI_ARGV_LIMIT` | Byte threshold for spilling large subprocess prompts to a temp file. |
| `DEBUG=1` | Print parsed cline NDJSON events to stderr. |
