# @openclineclicode/provider-cline-cli

> A Vercel AI SDK v3 (`LanguageModelV3`) adapter that delegates to a locally installed `cline` CLI subprocess.

이 패키지는 [openclineclicode](../../README.md) 번들의 핵심입니다. 단독으로 사용할 수도 있습니다.

## Install

```bash
npm install @openclineclicode/provider-cline-cli
```

## Use

```ts
import { generateText } from "ai"
import { createCline } from "@openclineclicode/provider-cline-cli"

const cline = createCline({ command: "cline", timeoutMs: 600_000 })

const { text } = await generateText({
  model: cline.languageModel("default"),
  prompt: "List the .ts files in src/.",
})

console.log(text)
```

## Options

```ts
interface ClineProviderOptions {
  mode?: "subprocess" | "passthrough"  // default "subprocess" (passthrough TODO)
  command?: string                      // default "cline"
  extraArgs?: string[]                  // appended after --json --yolo --act
  cwd?: string                          // override working dir
  timeoutMs?: number                    // default 600_000 (10 min)
  env?: Record<string, string>          // pass-through env vars
}
```

## Modes

- **subprocess** (default, implemented): spawns `cline --json --yolo --act "<prompt>"` and parses NDJSON output.
- **passthrough** (not yet implemented): would read `~/.cline/data/globalState.json` and call the underlying LLM directly.

See [docs/provider-modes.md](../../docs/provider-modes.md) in the bundle.

## License

MIT.
