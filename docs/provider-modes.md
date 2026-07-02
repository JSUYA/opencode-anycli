# Provider Modes

The provider drives one of three CLIs, selected by the `cli` option
(`cline` / `claude` / `codex`). cline supports the three `mode` values below;
claude and codex always run as subprocess stream-json sessions (see the last
section).

`provider-cline-cli` supports three mode values for cline. `subprocess` is the default, `acp` is implemented as an opt-in transport, and `passthrough` is planned.

## Subprocess

Subprocess mode starts cline for every model request with `cline --json --yolo -m <model> --act <prompt>`. It is slower, but it preserves cline's own tools and model configuration.

Large prompts are handled automatically: when the flattened prompt exceeds the safe argv threshold, the provider writes it to a `0600` temp file and sends cline a small wrapper prompt instructing it to read that file. This avoids Linux `E2BIG` failures from the kernel's per-argument limit while keeping the default transport compatible with existing cline versions.

## ACP

ACP mode starts cline with `cline --acp` and speaks the Agent Client Protocol over stdio JSON-RPC. The prompt travels in the protocol body rather than argv, and the provider translates ACP session updates into the same opencode stream parts used by subprocess mode.

> **⚠️ ACP is NOT available in the Samsung `cline-sr` build (0.6.0).** That CLI has no `--acp` flag — because it enables `allowUnknownOption`, passing `--acp` is silently ignored and cline falls back to interactive TUI mode, which aborts with `error: interactive mode requires a TTY (stdin/stdout must both be terminals)` when opencode drives it over pipes. **Keep `mode: "subprocess"`** (the installed default). Subprocess mode already handles arbitrarily large prompts via the temp-file spill, so there is no functional reason to switch. Only select `mode: "acp"` against an upstream cline build that actually ships the `--acp` transport.

## Passthrough

Passthrough mode is planned. It would read cline settings and call the configured model directly from opencode. This can reduce agent-on-agent overhead, but requires more coupling to cline's internal configuration format.

## Claude / Codex (subprocess stream-json)

Selecting a `claude/*` or `codex/*` model drives the matching CLI as a
subprocess that streams line-delimited JSON:

- claude: `claude -p --output-format stream-json --include-partial-messages --verbose --model <model> --effort <level> --permission-mode bypassPermissions`
- codex: `codex exec --json -m <model> -c model_reasoning_effort=<level> --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`

The flattened prompt is delivered on stdin (no argv length ceiling), the model
and reasoning effort come from the model id (e.g. `opus-4.8-max`,
`gpt-5.5-xhigh`), and the yolo permission bypass is applied automatically.
Neither CLI has a native `--acp` transport, so `mode` does not apply to them;
they use the existing local OAuth login for credentials.

## Recommendation

Use subprocess mode by default. Use ACP when you specifically want to exercise cline's ACP transport or need its richer structured updates. Passthrough should not be selected until it is implemented.
