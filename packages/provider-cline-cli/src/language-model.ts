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
import { appendFileSync } from "node:fs"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { runOnce, runStream } from "./cline-runner.js"
import { runOnceAcp, runStreamAcp } from "./cline-acp-runner.js"
import { composeClineHandoff, type ClineHandoffDiagnostics } from "./cline-handoff.js"
import type { ClineMode, ClineProviderOptions, ClineUsage } from "./types.js"

const DEFAULT_TIMEOUT_MS = 3_600_000

export class ClineLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "cline"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly options: {
    mode: ClineMode
    command: string
    timeoutMs: number
    extraArgs: readonly string[] | undefined
    cwd: string | undefined
    env: Record<string, string> | undefined
  }

  constructor(modelId: string, options: ClineProviderOptions = {}) {
    this.modelId = modelId
    const envOverrideBin = process.env["OPENCODE_ANYCLI_CLINE_BIN"]
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

    const handoff = composeClineHandoff({ prompt: options.prompt as ReadonlyArray<unknown> })
    const promptText = handoff.text
    logPromptDebug("generate", options.prompt as ReadonlyArray<unknown>, promptText, handoff.diagnostics)
    const runner = this.options.mode === "acp" ? runOnceAcp : runOnce
    const result = await runner({
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
      usage: toV3Usage(result.usage),
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

    const handoff = composeClineHandoff({ prompt: options.prompt as ReadonlyArray<unknown> })
    const promptText = handoff.text
    logPromptDebug("stream", options.prompt as ReadonlyArray<unknown>, promptText, handoff.diagnostics)
    const modelId = this.modelId
    const command = this.options.command
    const timeoutMs = this.options.timeoutMs
    const extraArgs = this.options.extraArgs
    const cwd = this.options.cwd
    const env = this.options.env
    const streamFn = this.options.mode === "acp" ? runStreamAcp : runStream
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

        // We open a text block lazily (only when actual text-deltas arrive)
        // and close it before any non-text part. That keeps the V3 stream
        // protocol clean: no tool-call stuck in the middle of a still-open
        // text block, no orphan empty text-start/text-end pair.
        let textBlockCounter = 0
        let activeTextBlockId: string | null = null
        const openTextBlock = (): string => {
          if (activeTextBlockId !== null) return activeTextBlockId
          const id = `text-${textBlockCounter++}`
          controller.enqueue({ type: "text-start", id })
          activeTextBlockId = id
          return id
        }
        const closeTextBlock = () => {
          if (activeTextBlockId === null) return
          controller.enqueue({ type: "text-end", id: activeTextBlockId })
          activeTextBlockId = null
        }

        let usage: ClineUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCost: undefined,
        }
        let parseErrors = 0
        let emittedToolCall = false
        try {
          for await (const ev of streamFn({
            prompt: promptText,
            options: { command, timeoutMs, extraArgs, cwd, env },
            signal: options.abortSignal,
          })) {
            if (ev.type === "text-delta") {
              const id = openTextBlock()
              controller.enqueue({ type: "text-delta", id, delta: ev.delta })
            } else if (ev.type === "tool-call") {
              closeTextBlock()
              // Emit a regular (non-provider-executed) tool-call for
              // opencode's built-in `read` tool. opencode's session
              // processor invokes its read-tool handler, which runs
              // `LSP.touchFile(filePath)` — that is what activates the
              // matching language server in the right-hand "LSP" panel
              // ("LSPs will activate as files are read"). We deliberately
              // pair this with `finishReason: "stop"` below so opencode
              // does NOT continue the conversation loop with the tool
              // result; cline already produced the final answer.
              controller.enqueue({
                type: "tool-call",
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                input: JSON.stringify(ev.input),
              })
              emittedToolCall = true
            } else if (ev.type === "tool-result") {
              // No-op: opencode generates the real tool-result by running
              // the read tool itself. We only emit the tool-call.
            } else if (ev.type === "finish") {
              usage = ev.usage
              parseErrors = ev.parseErrors
            } else if (ev.type === "error") {
              throw ev.error
            }
          }
          closeTextBlock()
          // Always end with `stop` — even when we emitted provider-executed
          // tool-calls. cline finished its task autonomously, so opencode
          // should not feed any "tool result" back into the model.
          // (`tool-calls` reason caused an infinite re-prompt loop in
          // testing; `providerExecuted: true` on the tool-call is what
          // signals to opencode that we already ran it.)
          void emittedToolCall
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: toV3Usage(usage),
            providerMetadata: {
              cline: { parseErrors, modelLabel: modelId },
            },
          })
          controller.close()
        } catch (err) {
          closeTextBlock()
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

function logPromptDebug(
  mode: "generate" | "stream",
  prompt: ReadonlyArray<unknown>,
  handoff: string,
  diagnostics: ClineHandoffDiagnostics,
): void {
  const path = process.env["OPENCODE_ANYCLI_PROMPTLOG"]
  if (!path) return
  try {
    appendFileSync(
      path,
      JSON.stringify(
        {
          ts: Date.now(),
          mode,
          handoffBytes: diagnostics.handoffBytes,
          flattenedBytes: diagnostics.handoffBytes,
          originalBytes: diagnostics.originalBytes,
          policyId: diagnostics.policyId,
          messageBreakdown: diagnostics.messageBreakdown,
          promptArray: prompt,
          handoff,
        },
        null,
        2,
      ) + "\n---\n",
      "utf8",
    )
  } catch {
    /* diagnostic logging must never break a model call */
  }
}

function toV3Usage(usage: ClineUsage): import("@ai-sdk/provider").LanguageModelV3Usage {
  const inputTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const raw: Record<string, number> = {}
  if (usage.inputTokens > 0) raw["tokensIn"] = usage.inputTokens
  if (usage.outputTokens > 0) raw["tokensOut"] = usage.outputTokens
  if (usage.cacheWriteTokens > 0) raw["cacheWrites"] = usage.cacheWriteTokens
  if (usage.cacheReadTokens > 0) raw["cacheReads"] = usage.cacheReadTokens
  if (usage.totalCost !== undefined) raw["cost"] = usage.totalCost

  // When ANY token signal is present we report concrete numbers (0 for the
  // missing axis) instead of `undefined`. opencode's session aggregator
  // tolerates 0 fine, but some TUI display paths gate on the field being
  // a *number* and silently render 0 when the whole usage object looks
  // empty — concrete zeros make sure the panel advances.
  const hasAnySignal =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0
  const result: import("@ai-sdk/provider").LanguageModelV3Usage = {
    inputTokens: {
      total: hasAnySignal ? inputTotal : undefined,
      noCache: hasAnySignal ? usage.inputTokens : undefined,
      cacheRead: hasAnySignal ? usage.cacheReadTokens : undefined,
      cacheWrite: hasAnySignal ? usage.cacheWriteTokens : undefined,
    },
    outputTokens: {
      total: hasAnySignal ? usage.outputTokens : undefined,
      text: hasAnySignal ? usage.outputTokens : undefined,
      reasoning: undefined,
    },
  }

  if (Object.keys(raw).length > 0) result.raw = raw
  logUsageDebug(usage, result)
  return result
}

/**
 * Optional usage diagnostic dump.
 *
 * Set OPENCODE_ANYCLI_USAGELOG=/path/to/log to record every (raw → v3) usage
 * mapping the provider returns. Useful for diagnosing "context shows 0
 * tokens" issues end-to-end without instrumenting opencode itself.
 */
function logUsageDebug(
  internal: ClineUsage,
  v3: import("@ai-sdk/provider").LanguageModelV3Usage,
): void {
  const path = process.env["OPENCODE_ANYCLI_USAGELOG"]
  if (!path) return
  try {
    appendFileSync(
      path,
      JSON.stringify({ ts: Date.now(), internal, v3 }) + "\n",
      "utf8",
    )
  } catch {
    /* diagnostic logging must never break a model call */
  }
}
