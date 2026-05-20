# OpenCode-AnyCLI

Run opencode with your existing cline CLI setup.

OpenCode-AnyCLI keeps cline as the model caller, while opencode provides the TUI,
project workflow, agents, commands, and session experience. You do not need to
copy model keys or recreate cline settings inside opencode.

## When to use it

Use OpenCode-AnyCLI when you want cline-backed coding work to run inside an
opencode workflow:

- codebase navigation and session context
- repeatable inspect -> edit -> verify loops
- slash commands, skills, and agents from opencode or Oh-My-AnyCLI
- isolated opencode config under `~/.config/opencode-anycli`

For quick one-shot questions or tiny edits, plain `cline` can still be faster.

## Requirements

| Tool | Requirement |
|---|---|
| OS | Ubuntu 22.04 / 24.04, other Linux distributions, or macOS |
| Node.js | 20 or newer |
| npm | bundled with Node.js |
| git | required for clone and update |
| bun | optional; used by the installer when available |

If `opencode`, `cline`, or `typescript-language-server` are missing, the
installer can install them automatically with npm.

## Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh
opencode-anycli
```

Common install flags:

| Flag | Purpose |
|---|---|
| `--skip-build` | Skip the workspace build step |
| `--no-auto-deps` | Fail if required CLIs are missing instead of installing them |
| `--no-lsp-deps` | Skip `typescript-language-server` installation |
| `--yes`, `-y` | Skip installer confirmations |

## Daily use

```bash
opencode-anycli
opencode-anycli --doctor
opencode-anycli --fix
opencode-anycli --update
```

Useful runtime flags:

| Flag | Purpose |
|---|---|
| `--auto-approve`, `--yolo`, `-y` | Let opencode run tools without approval prompts |
| `--no-tty` | Disable TTY stdin forwarding for CI or pipe-fed runs |
| `--allow-dangerously-skip-permissions` | Re-run the session under `sudo -E` |

Use `--allow-dangerously-skip-permissions` only in a trusted checkout or
disposable environment. Files created during that session may be root-owned.

## TUI defaults

OpenCode-AnyCLI installs a small TUI config. Enter and Shift+Enter follow
opencode's upstream defaults (Enter submits, Shift+Enter inserts a newline
when the terminal reports the Shift modifier). The only override shipped is:

| Key | Action |
|---|---|
| Ctrl+C | Open an exit confirmation dialog |

To customize bindings, edit:

```text
~/.config/opencode-anycli/opencode/tui.json
```

## Update

```bash
opencode-anycli --update
opencode-anycli --update --skip-build
```

Update performs a safe fast-forward pull, re-runs `install.sh`, and preserves
local uncommitted changes with an automatic stash when needed.

## Diagnostics

```bash
opencode-anycli --doctor
opencode-anycli --fix
opencode-anycli --fix-yes
```

`--doctor` checks the installed runtime, config, PATH, LSP dependencies, common
permission problems, and known opencode startup blockers. `--fix` offers
interactive recovery for issues it can repair.

## Uninstall

```bash
./uninstall.sh
./uninstall.sh --purge-config
./uninstall.sh --purge-build
./uninstall.sh --purge-all
```

The uninstaller runs `npm unlink -g opencode-anycli` to drop the global
symlink, strips any legacy PATH block from your shell rc files, and removes
OpenCode-AnyCLI-managed files only. It does not remove your normal `cline`,
`~/.cline/`, or `~/.config/opencode/` setup.

## Configuration

OpenCode-AnyCLI writes its opencode config here:

```text
~/.config/opencode-anycli/opencode/
```

cline remains the source of truth for model credentials and model behavior.

Oh-My-AnyCLI can add more agents, slash commands, skills, and workflow presets:

[Oh-My-AnyCLI](https://github.com/JSUYA/oh-my-anycli)

## More documentation

- [Installation](./docs/installation.md)
- [Configuration](./docs/configuration.md)
- [Provider modes](./docs/provider-modes.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Architecture](./docs/architecture.md)

## License

MIT. opencode and cline are separate upstream projects with their own licenses.
