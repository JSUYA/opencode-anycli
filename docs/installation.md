# Installation

This guide installs openclineclicode so opencode can run through the local cline CLI.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Node.js | 20 or newer |
| opencode | Available on `PATH` |
| cline | Available on `PATH` and configured once |
| Bun | Optional; npm is used when Bun is unavailable |

## Quick Install

```bash
git clone https://example.invalid/openclineclicode.git
cd openclineclicode
./install.sh
```

The installer checks Node, opencode, and cline, builds the workspace, writes the default `opencode.json`, and links the `openclineclicode` binary.

## Options

| Flag | Description |
| --- | --- |
| `--user` | Link the binary into `~/.local/bin` without sudo. |
| `--sudo` | Use sudo when linking into `/usr/local/bin`. |
| `--skip-build` | Reuse existing `dist/` outputs. |

## Cline First Run

Run cline once before using openclineclicode:

```bash
cline
```

Complete cline's model and credential setup. openclineclicode expects `~/.cline/data/globalState.json` to exist.

## Reinstall From Existing Build

```bash
tar czf openclineclicode-bundle.tgz openclineclicode/
tar xzf openclineclicode-bundle.tgz
cd openclineclicode
./install.sh --skip-build --user
```
