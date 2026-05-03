# Configuration

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/openclineclicode/opencode/opencode.json` | opencode configuration and adapter registration. |
| `~/.config/openclineclicode/opencode/AGENTS.md` | Default agent instructions. |
| `~/.config/openclineclicode/opencode/{commands,agents,skills}/` | Optional extensions installed by oh-my-clinecli. |
| `~/.cline/data/globalState.json` | cline-managed model settings. |
| `~/.cline/data/secrets.json` | cline-managed secrets when present. |

The CLI sets `XDG_CONFIG_HOME=$HOME/.config/openclineclicode` when starting opencode, unless the user already exported `XDG_CONFIG_HOME`.

## Provider Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `subprocess` or `passthrough` | `subprocess` | `passthrough` is not implemented yet. |
| `command` | string | `cline` | Path to the cline binary. |
| `extraArgs` | string array | `[]` | Additional cline arguments. |
| `cwd` | string | opencode working directory | Optional working directory override. |
| `timeoutMs` | number | `600000` | Subprocess timeout. |
| `env` | object | `{}` | Extra environment variables for cline. |

## Environment Variables

| Variable | Description |
| --- | --- |
| `OPENCLINECLICODE_CLINE_BIN` | Override the cline binary path. |
| `OPENCLINECLICODE_CONFIG` | Override the opencode config path. |
| `DEBUG=1` | Print parsed cline NDJSON events to stderr. |
