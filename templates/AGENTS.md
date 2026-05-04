# Default Agent Instructions

This file ships with OpenCode-AnyCLI and is copied to `~/.config/opencode-anycli/AGENTS.md` on first install. Customize it for your own workflow.

## Cline CLI Etiquette

- Respect the user's existing cline configuration.
- Do not guess model names, credentials, or endpoints.
- Protect secrets found in code or documents.
- Keep prompts clear because opencode delegates to a second agent loop in cline.
- Keep responses and comments in English unless the user asks otherwise.

## Tool Usage

Use opencode-side tools mainly for context collection and final verification. Let cline handle delegated model work through its configured workflow.
