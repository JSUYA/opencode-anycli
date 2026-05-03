# @opencode-anycli/provider-cline-cli

A Vercel AI SDK v3 `LanguageModelV3` adapter that delegates generation to a locally installed `cline` CLI subprocess.

## Usage

```ts
import { createCline } from "@opencode-anycli/provider-cline-cli"

const provider = createCline()
const model = provider.languageModel("default")
```

The adapter currently supports subprocess mode. See the repository documentation for opencode integration details.
