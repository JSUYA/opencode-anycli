// LanguageModelV3 implementation that delegates to the cline CLI subprocess.
//
// Implements the Vercel AI SDK v3 contract:
//   - specificationVersion: "v3"
//   - provider, modelId, supportedUrls
//   - doGenerate(options): Promise<{ content, finishReason, usage, ... }>
//   - doStream(options): Promise<{ stream, ... }>
//
// We import types from @ai-sdk/provider, but if a type is awkward to satisfy
// at the structural level we cast at the boundary — typed against the names
// that exist in @ai-sdk/provider@^3.0.8.

import { randomUUID } from "node:crypto"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { runOnce, runStream } from "./cline-runner.js"
import { flattenPrompt } from "./prompt-flatten.js"
import type { ClineProviderOptions } from "./types.js"

const DEFAULT_TIMEOUT_MS = 600_000

export class ClineLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "cline"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly options: {
    mode: "subprocess" | "passthrough"
    command: string
    timeoutMs: number
    extraArgs: readonly string[] | undefined
    cwd: string | undefined
    env: Record<string, string> | undefined
  }

  constructor(modelId: string, options: ClineProviderOptions = {}) {
    this.modelId = modelId
    const envOverrideBin = process.env["OPENCLINECLICODE_CLINE_BIN"]
    this.options = {
      mode: options.mode ?? "subprocess",
      command: envOverrideBin ?? options.command ?? "cline",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      extraArgs: options.extraArgs,
      cwd: options.cwd,
      env: options.env,
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    if (this.options.mode === "passthrough") {
      // TODO: implement passthrough mode — read ~/.cline/data/globalState.json
      // and ~/.cline/data/secrets.json, then construct an @ai-sdk/openai-compatible
      // provider and delegate doGenerate to it. See docs/provider-modes.md.
      throw new Error("Passthrough mode not yet implemented — see docs/provider-modes.md")
    }

    const promptText = flattenPrompt({ prompt: options.prompt as ReadonlyArray<unknown> })
    const result = await runOnce({
      prompt: promptText,
      options: {
        command: this.options.command,
        timeoutMs: this.options.timeoutMs,
        extraArgs: this.options.extraArgs,
        cwd: this.options.cwd,
        env: this.options.env,
      },
      signal: options.abortSignal,
    })

    const finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined }

    return {
      content: [{ type: "text", text: result.text }],
      finishReason,
      usage: toV3Usage(result.usage.inputTokens, result.usage.outputTokens),
      warnings: [],
      response: {
        id: cryptoRandomId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        cline: {
          parseErrors: result.parseErrors,
          modelLabel: this.modelId,
        },
      },
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    if (this.options.mode === "passthrough") {
      throw new Error("Passthrough mode not yet implemented — see docs/provider-modes.md")
    }

    const promptText = flattenPrompt({ prompt: options.prompt as ReadonlyArray<unknown> })
    const modelId = this.modelId
    const command = this.options.command
    const timeoutMs = this.options.timeoutMs
    const extraArgs = this.options.extraArgs
    const cwd = this.options.cwd
    const env = this.options.env
    const responseId = cryptoRandomId()

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        controller.enqueue({
          type: "response-metadata",
          id: responseId,
          timestamp: new Date(),
          modelId,
        })
        const textBlockId = "text-0"
        controller.enqueue({ type: "text-start", id: textBlockId })

        let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        let parseErrors = 0
        try {
          for await (const ev of runStream({
            prompt: promptText,
            options: { command, timeoutMs, extraArgs, cwd, env },
            signal: options.abortSignal,
          })) {
            if (ev.type === "text-delta") {
              controller.enqueue({ type: "text-delta", id: textBlockId, delta: ev.delta })
            } else if (ev.type === "finish") {
              usage = ev.usage
              parseErrors = ev.parseErrors
            } else if (ev.type === "error") {
              throw ev.error
            }
          }
          controller.enqueue({ type: "text-end", id: textBlockId })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: toV3Usage(usage.inputTokens, usage.outputTokens),
            providerMetadata: {
              cline: { parseErrors, modelLabel: modelId },
            },
          })
          controller.close()
        } catch (err) {
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          controller.close()
        }
      },
    })

    return {
      stream,
      response: { headers: {} },
    }
  }
}

function cryptoRandomId(): string {
  return `cline-${randomUUID()}`
}

function toV3Usage(inputTokens: number, outputTokens: number): import("@ai-sdk/provider").LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens || undefined,
      noCache: inputTokens || undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens || undefined,
      text: outputTokens || undefined,
      reasoning: undefined,
    },
  }
}
