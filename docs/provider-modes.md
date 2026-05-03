# Provider Modes

`provider-cline-cli` supports a mode option. Only subprocess mode is implemented today.

## Subprocess

Subprocess mode starts cline for every model request. It is slower, but it preserves cline's own tools and model configuration.

## Passthrough

Passthrough mode is planned. It would read cline settings and call the configured model directly from opencode. This can reduce agent-on-agent overhead, but requires more coupling to cline's internal configuration format.

## Recommendation

Use subprocess mode unless you are actively working on passthrough support.
