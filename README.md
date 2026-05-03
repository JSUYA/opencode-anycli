# openclineclicode

> Run the opencode AI coding agent through your locally installed cline CLI.

openclineclicode installs a small opencode adapter that forwards model requests to `cline --json --yolo --act <prompt>`. cline keeps using the model, credentials, and tool behavior the user has already configured.

## Why This Exists

- opencode provides a strong TUI and multi-agent workflow.
- cline CLI already knows how to call the user's configured model.
- This bundle connects the two without asking users to duplicate model settings in opencode.

## Install

```bash
git clone https://example.invalid/openclineclicode.git
cd openclineclicode
./install.sh
```

After installation, run:

```bash
openclineclicode
```

## Architecture

```text
opencode -> provider-cline-cli -> cline CLI -> configured model
   ^              |                  |
   |              +-- NDJSON parse <--+
   +---------------- assistant text
```

The adapter implements the Vercel AI SDK v3 `LanguageModelV3` interface expected by opencode. It starts cline as a subprocess, parses cline's NDJSON event stream, and returns the final assistant text to opencode.

## Modes

- `subprocess`: implemented. Uses cline as a subprocess and preserves cline tool behavior.
- `passthrough`: planned. Would read cline settings and call the model directly from opencode.

## Companion Project

[oh-my-clinecli](https://example.invalid/oh-my-clinecli) adds reusable skills, slash commands, subagents, and plugins on top of openclineclicode.

## Documentation

- [Installation](./docs/installation.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Provider modes](./docs/provider-modes.md)
- [Troubleshooting](./docs/troubleshooting.md)

## License

MIT. opencode and cline are separate projects with their own licenses.
