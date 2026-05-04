# Installation

This guide installs OpenCode-AnyCLI so opencode can run through the local cline CLI.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Node.js | 20 or newer |
| opencode | Available on `PATH` |
| cline | Available on `PATH` and configured once |
| Bun | Optional; npm is used when Bun is unavailable |

## Quick Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh
```

The installer checks Node, opencode, and cline, builds the workspace, writes the default `opencode.json`, and links the `opencode-anycli` binary.

## Options

| Flag | Description |
| --- | --- |
| `--user` | Link the binary into `~/.local/bin` without sudo. |
| `--sudo` | Use sudo when linking into `/usr/local/bin`. |
| `--skip-build` | Reuse existing `dist/` outputs. |

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
./install.sh --skip-build --user
```
