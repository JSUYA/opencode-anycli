# Installation

This guide installs OpenCode-AnyCLI so opencode can run through the local cline CLI.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Node.js | 20 or newer |
| npm | Bundled with Node; used for workspace build and runtime dependency install |
| git | Required for clone and `opencode-anycli --update` |
| opencode | Auto-installed by `install.sh` via `npm install -g opencode-ai` when missing |
| cline | Auto-installed by `install.sh` via `npm install -g cline` when missing; run once to configure credentials |
| Bun | Optional; npm is used when Bun is unavailable |

## Quick Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh
```

The installer checks Node, opencode, and cline, builds the workspace, writes the default `opencode.json` and `tui.json`, and adds the repo's `packages/cli/bin` directory to your shell rc file with a managed PATH block.

## Options

| Flag | Description |
| --- | --- |
| `--skip-build` | Reuse existing `dist/` outputs. |
| `--rebuild` | Force a fresh workspace build. |
| `--no-auto-deps` | Do not auto-install opencode/cline; fail if they are missing. |
| `--no-lsp-deps` | Do not auto-install `typescript-language-server`. |
| `--user`, `--sudo` | Deprecated no-ops kept for older wrapper commands. |

## Cline First Run

Run cline once before using OpenCode-AnyCLI:

```bash
cline
```

Complete cline's model and credential setup. OpenCode-AnyCLI expects `~/.cline/data/globalState.json` to exist.

## Reinstall From Existing Build

```bash
tar czf opencode-anycli-bundle.tgz opencode-anycli/
tar xzf opencode-anycli-bundle.tgz
cd opencode-anycli
./install.sh --skip-build
```

`--user` is accepted for compatibility but no longer changes the install location; the PATH block is always used.
