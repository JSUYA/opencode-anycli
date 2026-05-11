# Configuration

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode-anycli/opencode/opencode.json` | opencode configuration and adapter registration. |
| `~/.config/opencode-anycli/opencode/tui.json` | TUI keybinds and the exit-confirm plugin entry. |
| `~/.config/opencode-anycli/opencode/AGENTS.md` | Default agent instructions. |
| `~/.config/opencode-anycli/opencode/{commands,agents,skills}/` | Optional opencode extensions in the wrapper-private config directory. |
| `~/.cline/data/globalState.json` | cline-managed model settings. |
| `~/.cline/data/secrets.json` | cline-managed secrets when present. |

The CLI sets `XDG_CONFIG_HOME=$HOME/.config/opencode-anycli` when starting opencode. To override that wrapper-private XDG directory, set `OPENCODE_ANYCLI_XDG`.

## Provider Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `subprocess` or `acp` | `subprocess` | Transport used to call cline. `passthrough` is reserved and currently throws. |
| `command` | string | `cline` | Path to the cline binary. |
| `extraArgs` | string array | `[]` | Additional cline arguments. |
| `cwd` | string | opencode working directory | Optional working directory override. |
| `timeoutMs` | number | `600000` | cline request timeout. |
| `env` | object | `{}` | Extra environment variables for cline. |

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
| `DEBUG=1` | Print provider debug output to stderr. |
