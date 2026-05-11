# Installation

Install OpenCode-AnyCLI from a local checkout so opencode can run through your
existing cline CLI setup.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Node.js | 20 or newer |
| npm | Bundled with Node; used for global runtime dependency installs |
| git | Required for clone and `opencode-anycli --update` |
| opencode | Auto-installed or upgraded by `install.sh` unless `--no-auto-deps` is set |
| cline | Auto-installed by `install.sh` unless `--no-auto-deps` is set |
| Bun | Optional; used for workspace install/build when available, with npm as the fallback |

## Quick Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh
# Open a new terminal, then run:
opencode-anycli --doctor
opencode-anycli
```

The installer checks Node, opencode, cline, and the TypeScript language server,
builds the workspace, writes the default `opencode.json` and `tui.json`, and
adds the repo's `packages/cli/bin` directory to your shell rc file with a
managed PATH block.

## Options

| Flag | Description |
| --- | --- |
| `--skip-build` | Reuse existing `dist/` outputs. |
| `--rebuild` | Force a fresh workspace build. |
| `--no-auto-deps` | Do not auto-install opencode/cline; fail if they are missing. |
| `--no-lsp-deps` | Do not auto-install `typescript-language-server`. |
| `--yes`, `-y` | Skip installer confirmations. |

`--user` and `--sudo` are accepted for compatibility with older wrapper
commands, but current installs use the managed PATH block and do not need
symlinks or sudo for the link step.

## Cline First Run

If `opencode-anycli --doctor` reports that cline has not been configured, run
cline once:

```bash
cline
```

Complete cline's model and credential setup. OpenCode-AnyCLI expects `~/.cline/data/globalState.json` to exist.
