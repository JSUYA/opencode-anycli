# Changelog

## 0.1.0 - 2026-05-03

Initial release.

### Added

- Vercel AI SDK v3 `LanguageModelV3` adapter for cline CLI.
- Subprocess mode using `cline --json --yolo --act`.
- CLI wrapper for launching opencode with isolated configuration.
- Installer, doctor script, and smoke checks.
- Unit tests for prompt flattening, NDJSON parsing, language-model behavior, and CLI config handling.

### Known Limitations

- Passthrough mode is planned but not implemented.
- macOS and Linux are supported; Windows is not currently supported.
- Token usage depends on the events emitted by cline.
