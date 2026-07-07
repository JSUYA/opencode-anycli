# Provider Modes

## OpenAI-compatible facade (experimental)

Set `OPENCODE_ANYCLI_PROVIDER=openai-compat` or pass
`opencode-anycli --provider openai-compat` to start a local OpenAI-compatible
server before opencode starts. The wrapper materializes a temporary opencode
config that keeps the provider id as `cline`, but changes its implementation to
`@ai-sdk/openai-compatible` with a local `baseURL` and one-time bearer token.

The facade still calls the local `cline` CLI internally. It does not read cline
credentials or call the model API directly. Cline-native tool activity remains
internal to cline; host-side opencode calls such as `skill` and `task` are
returned as OpenAI `tool_calls`.

The provider drives one of three CLIs, selected by the `cli` option
(`cline` / `claude` / `codex`). cline supports the three `mode` values below;
claude and codex always run as subprocess stream-json sessions (see the last
section).

`provider-cline-cli` supports four mode values for cline. `auto` is the default (recommended), `subprocess` and `acp` force a specific transport, and `passthrough` is planned.

## Auto (default)

`mode: "auto"` probes `cline --help` once per process and selects the transport automatically:

- Binary advertises `--acp` (Samsung cline-sr **0.5.1**) → **ACP**.
- Binary lacks `--acp` (cline-sr **0.6.0** removed it) → **subprocess**.

No manual config or reinstall is needed when cline is upgraded/downgraded — the probe result is cached per command for the process lifetime. Set `mode` explicitly to `"acp"` or `"subprocess"` to bypass detection. The probe runs `cline --help` (no API call) and falls back to subprocess on any error/timeout.

## Subprocess

Subprocess mode starts cline for every model request with `cline --json --yolo -m <model> --act <prompt>`. It is slower, but it preserves cline's own tools and model configuration.

Large prompts are handled automatically: when the flattened prompt exceeds the safe argv threshold, the provider writes it to a `0600` temp file and sends cline a small wrapper prompt instructing it to read that file. This avoids Linux `E2BIG` failures from the kernel's per-argument limit while keeping the default transport compatible with existing cline versions.

## ACP

ACP mode starts cline with `cline --acp` and speaks the Agent Client Protocol over stdio JSON-RPC. The prompt travels in the protocol body rather than argv, and the provider translates ACP session updates into the same opencode stream parts used by subprocess mode: native tool calls (read/bash/edit/write/grep) are bridged as provider-executed tool-call/result parts, cline reasoning becomes a V3 reasoning part, and token usage is recovered from the persisted cline task files.

> **Version requirement.** ACP needs a cline-sr build that ships `--acp`: **0.5.1 has it, 0.6.0 removed it.** On a build without `--acp` the flag is silently ignored (cline enables `allowUnknownOption`) and cline falls into interactive TUI mode, aborting with `error: interactive mode requires a TTY` when driven over pipes. Prefer `mode: "auto"` — it detects `--acp` support and only uses ACP when available, falling back to subprocess otherwise. Force `mode: "acp"` only against a build you know supports it.

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

Leave `mode: "auto"` (the default). It runs ACP on cline-sr 0.5.1 (larger context via the JSON-RPC body, structured tool/reasoning updates) and subprocess on 0.6.0, with no manual switching. Force `subprocess` or `acp` only to pin a transport for debugging. Passthrough should not be selected until it is implemented.
