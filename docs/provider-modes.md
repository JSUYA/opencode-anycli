# Provider Modes

`provider-cline-cli` has two usable transports: `subprocess` and `acp`.
`subprocess` is the default. `passthrough` is reserved in the type surface but
is not implemented and should not be selected.

## Subprocess

Subprocess mode starts cline for every model request with
`cline --json --yolo --act <prompt>`. It is slower, but it preserves cline's own
tools and model configuration.

Large prompts are handled automatically: when the flattened prompt exceeds the safe argv threshold, the provider writes it to a `0600` temp file and sends cline a small wrapper prompt instructing it to read that file. This avoids Linux `E2BIG` failures from the kernel's per-argument limit while keeping the default transport compatible with existing cline versions.

## ACP

ACP mode starts cline with `cline --acp` and speaks the Agent Client Protocol
over stdio JSON-RPC. The prompt travels in the protocol body rather than argv,
and the provider translates ACP session updates into the same opencode stream
parts used by subprocess mode.

ACP requires cline 2.18 or newer. Older cline versions do not ship the `--acp` transport, so leave `mode` as `subprocess` unless `cline --version` reports 2.18+.

## Unsupported Mode

`passthrough` currently throws `Passthrough mode not yet implemented`. It is
kept out of the user-facing recommendation until there is a working runtime
path.

## Recommendation

Use subprocess mode by default. Use ACP only when you specifically need cline's
ACP transport or richer structured updates. Long prompts alone do not require
ACP because subprocess mode already spills oversized prompts to a temp file.
