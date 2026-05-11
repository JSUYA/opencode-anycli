# Provider Modes

`provider-cline-cli` supports three mode values. `subprocess` is the default, `acp` is implemented as an opt-in transport, and `passthrough` is planned.

## Subprocess

Subprocess mode starts cline for every model request with `cline --json --yolo --act <prompt>`. It is slower, but it preserves cline's own tools and model configuration.

Large prompts are handled automatically: when the flattened prompt exceeds the safe argv threshold, the provider writes it to a `0600` temp file and sends cline a small wrapper prompt instructing it to read that file. This avoids Linux `E2BIG` failures from the kernel's per-argument limit while keeping the default transport compatible with existing cline versions.

## ACP

ACP mode starts cline with `cline --acp` and speaks the Agent Client Protocol over stdio JSON-RPC. The prompt travels in the protocol body rather than argv, and the provider translates ACP session updates into the same opencode stream parts used by subprocess mode.

ACP requires cline 2.18 or newer. Older cline versions do not ship the `--acp` transport, so leave `mode` as `subprocess` unless `cline --version` reports 2.18+.

## Passthrough

Passthrough mode is planned. It would read cline settings and call the configured model directly from opencode. This can reduce agent-on-agent overhead, but requires more coupling to cline's internal configuration format.

## Recommendation

Use subprocess mode by default. Use ACP when you specifically want to exercise cline's ACP transport or need its richer structured updates. Passthrough should not be selected until it is implemented.
