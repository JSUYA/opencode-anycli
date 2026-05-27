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
import {
  OpencodeCallParser,
  SUPPORTED_OPENCODE_CALL_TOOLS,
  detectSkillNaturalLanguageInHandoff,
  detectSkillSlashCommand,
  isSkillAlreadyDispatchedInHandoff,
  type OpencodeCall,
  type ProtocolToolDescriptor,
} from "./opencode-call-parser.js"
import type { ClineMode, ClineProviderOptions, ClineUsage } from "./types.js"

const DEFAULT_TIMEOUT_MS = 3_600_000

/**
 * Maximum number of tool-call turns before forcing a stop.
 * Prevents infinite loops when cline keeps generating new tool-calls
 * in a cycle. Can be overridden via OPENCODE_ANYCLI_MAX_TURNS env var.
 */
const DEFAULT_MAX_TURNS = 15

/**
 * Count model invocations since the last user message to detect loops.
 * Each assistant message in the prompt represents one model invocation.
 * Resets on user messages so normal multi-turn conversations aren't
 * penalised — only the depth of the current tool-use chain is measured.
 */
function countTurnsInPrompt(prompt: ReadonlyArray<unknown>): number {
  let turnsSinceLastUser = 0
  for (const message of prompt) {
    if (typeof message === "object" && message !== null) {
      const msg = message as Record<string, unknown>
      if (msg["role"] === "user") {
        turnsSinceLastUser = 0
      } else if (msg["role"] === "assistant") {
        turnsSinceLastUser++
      }
    }
  }
  return turnsSinceLastUser
}

/**
 * Create a hash signature for a tool-call to detect duplicates.
 * Returns a JSON string of toolName + sorted input keys for comparison.
 */
function createToolCallSignature(toolName: string, input: unknown): string {
  try {
    const sortedInput = JSON.stringify(input, Object.keys(input as object).sort())
    return JSON.stringify({ toolName, input: sortedInput })
  } catch {
    return JSON.stringify({ toolName, input: String(input) })
  }
}

/**
 * Check if a tool-call signature was already seen in this session.
 * Used to detect infinite loops where cline keeps generating the same tool-call.
 */
function isDuplicateToolCall(previousToolCalls: Set<string>, toolName: string, input: unknown): boolean {
  const signature = createToolCallSignature(toolName, input)
  return previousToolCalls.has(signature)
}

/**
 * Track a tool-call signature to detect future duplicates.
 * Call this after emitting a tool-call to prevent infinite loops.
 * 
 * Implements FIFO eviction when the cache exceeds MAX_TOOL_CALL_CACHE entries
 * to prevent unbounded memory growth in long-running sessions.
 */
function trackToolCall(
  previousToolCalls: Set<string>,
  toolName: string,
  input: unknown,
  maxCacheSize: number = 100,
): void {
  const signature = createToolCallSignature(toolName, input)
  
  // FIFO eviction: remove oldest entry if cache is full
  if (previousToolCalls.size >= maxCacheSize) {
    const firstKey = previousToolCalls.values().next().value
    if (firstKey !== undefined) {
      previousToolCalls.delete(firstKey)
    }
  }
  
  previousToolCalls.add(signature)
}

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

/**
 * Track previous tool-call hashes to detect duplicate tool-calls
 * that could indicate an infinite loop. Stores JSON-stringified
 * tool-call signatures (toolName + input hash).
 * 
 * Limited to MAX_TOOL_CALL_CACHE entries to prevent unbounded memory growth.
 * When the limit is exceeded, oldest entries are removed (FIFO eviction).
 */
private readonly previousToolCalls = new Set<string>()
private static readonly MAX_TOOL_CALL_CACHE = 100

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

    const tools = extractTools(options)
    const handoff = composeClineHandoff({
      prompt: options.prompt as ReadonlyArray<unknown>,
      tools,
    })
    const promptText = handoff.text
    logPromptDebug("generate", options.prompt as ReadonlyArray<unknown>, promptText, handoff.diagnostics)

    // Infinite loop prevention: check if we've exceeded max turns
    const maxTurns = parseInt(process.env["OPENCODE_ANYCLI_MAX_TURNS"] ?? String(DEFAULT_MAX_TURNS), 10)
    const currentTurns = countTurnsInPrompt(options.prompt as ReadonlyArray<unknown>)
    if (currentTurns >= maxTurns) {
      // Force stop to prevent infinite loop
      return {
        content: [{ type: "text", text: `[opencode-anycli] Maximum turns (${maxTurns}) reached. Stopping to prevent infinite loop. Use OPENCODE_ANYCLI_MAX_TURNS env var to increase limit if needed.` }],
        finishReason: { unified: "stop", raw: "max-turns-reached" },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, totalCost: undefined } as any,
        warnings: [],
        response: { id: cryptoRandomId(), timestamp: new Date(), modelId: this.modelId },
        providerMetadata: { cline: { parseErrors: 0, modelLabel: this.modelId, opencodeCalls: 0, maxTurnsReached: true } },
      }
    }

    // Slash-command bypass: opencode rewrites `/<skill>` user input into a
    // `<command-instruction>` block that tells the model "Run the X skill
    // workflow". Custom cline builds (e.g. GaussO3-CLI) reliably ignore
    // that instruction — they just answer with their own tools, so the
    // skill content never actually loads. We intercept the directive
    // here and emit the matching `skill` tool-call directly. opencode
    // then runs the skill, injects SKILL.md as the next turn's tool-
    // result, and cline finally sees the skill rules in context.
    // Source priority: slash command first (deterministic structured
    // directive), then natural-language pattern (user prose). Both emit
    // the same skill tool-call shape; only providerMetadata.cline.
    // skillBypassSource differs so downstream telemetry can tell them
    // apart.
    const slashSkill = maybeResolveSkillBypass(
      detectSkillSlashCommand(handoff.commandInstructions),
      tools,
      this.modelId,
      "slash",
      promptText,
    )
    if (slashSkill !== null) return slashSkill
    const nlSkill = maybeResolveSkillBypass(
      detectSkillNaturalLanguageInHandoff(promptText),
      tools,
      this.modelId,
      "natural-language",
      promptText,
    )
    if (nlSkill !== null) return nlSkill

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

    // Extract `<opencode-call>` tags from cline's text and convert them to
    // V3 tool-call content parts. When at least one is found we MUST set
    // finishReason = "tool-calls" so opencode dispatches them; otherwise
    // the call is a no-op and we keep "stop".
    const registeredToolNames = registeredSupportedToolNames(tools)
    const parsed =
      registeredToolNames.size > 0
        ? parseOpencodeCallsOnce(result.text, registeredToolNames)
        : { text: result.text, calls: [] }
    
    // Filter out duplicate tool-calls to prevent infinite loops
    const uniqueCalls: OpencodeCall[] = []
    const duplicateCallCount = { count: 0 }
    for (const call of parsed.calls) {
      if (isDuplicateToolCall(this.previousToolCalls, call.toolName, call.input)) {
        duplicateCallCount.count++
        continue
      }
      trackToolCall(this.previousToolCalls, call.toolName, call.input, ClineLanguageModel.MAX_TOOL_CALL_CACHE)
      uniqueCalls.push(call)
    }
    
    const content: Array<LanguageModelV3StreamPart | { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: string }> = []
    if (parsed.text.length > 0) content.push({ type: "text", text: parsed.text })
    for (const call of uniqueCalls) {
      content.push({
        type: "tool-call",
        toolCallId: cryptoToolCallId(),
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      })
    }
    const finishReason: LanguageModelV3FinishReason =
      uniqueCalls.length > 0
        ? { unified: "tool-calls", raw: undefined }
        : { unified: "stop", raw: duplicateCallCount.count > 0 ? "duplicate-tool-calls-filtered" : undefined }

    return {
      // The union above keeps the types narrow; cast at the boundary to the
      // SDK's Content[] type. All entries are valid V3 content variants.
      content: content as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>["content"],
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
          opencodeCalls: parsed.calls.length,
          ...(result.contextMax !== undefined ? { contextMax: result.contextMax } : {}),
        },
      },
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    if (this.options.mode === "passthrough") {
      throw new Error("Passthrough mode not yet implemented — see docs/provider-modes.md")
    }

    // Infinite loop prevention: check if we've exceeded max turns
    const maxTurns = parseInt(process.env["OPENCODE_ANYCLI_MAX_TURNS"] ?? String(DEFAULT_MAX_TURNS), 10)
    const currentTurns = countTurnsInPrompt(options.prompt as ReadonlyArray<unknown>)
    if (currentTurns >= maxTurns) {
      // Return a one-shot stream that immediately finishes with max-turns-reached
      const responseId = cryptoRandomId()
      const currentModelId = this.modelId
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({
              type: "response-metadata",
              id: responseId,
              timestamp: new Date(),
              modelId: currentModelId,
            })
            controller.enqueue({
              type: "text-delta",
              id: "text-0",
              delta: `[opencode-anycli] Maximum turns (${maxTurns}) reached. Stopping to prevent infinite loop. Use OPENCODE_ANYCLI_MAX_TURNS env var to increase limit if needed.`,
            })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "max-turns-reached" },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
              providerMetadata: {
                cline: { parseErrors: 0, modelLabel: currentModelId, opencodeCalls: 0, maxTurnsReached: true },
              },
            })
            controller.close()
          },
        }),
        response: { headers: {} },
      }
    }

    const tools = extractTools(options)
    const handoff = composeClineHandoff({
      prompt: options.prompt as ReadonlyArray<unknown>,
      tools,
    })
    const promptText = handoff.text
    logPromptDebug("stream", options.prompt as ReadonlyArray<unknown>, promptText, handoff.diagnostics)
    const modelId = this.modelId
    // Slash-command bypass (see doGenerate above for the rationale). On
    // the streaming path we return a synthetic ReadableStream that emits
    // just the skill tool-call + finishReason: tool-calls. opencode
    // dispatches the skill and re-enters us on the next turn.
    const slashStream = maybeResolveSkillBypassStream(
      detectSkillSlashCommand(handoff.commandInstructions),
      tools,
      modelId,
      "slash",
      promptText,
    )
    if (slashStream !== null) return slashStream
    const nlStream = maybeResolveSkillBypassStream(
      detectSkillNaturalLanguageInHandoff(promptText),
      tools,
      modelId,
      "natural-language",
      promptText,
    )
    if (nlStream !== null) return nlStream

    const registeredToolNames = registeredSupportedToolNames(tools)
    // Only instantiate the parser when at least one supported tool is
    // registered — saves the per-delta scan in the (very common) title /
    // summary / compaction calls that arrive without tools.
    const parserActive = registeredToolNames.size > 0
    const command = this.options.command
    const timeoutMs = this.options.timeoutMs
    const extraArgs = this.options.extraArgs
    const cwd = this.options.cwd
    const env = this.options.env
    const streamFn = this.options.mode === "acp" ? runStreamAcp : runStream
    const responseId = cryptoRandomId()

    // Tie consumer cancellation (reader.cancel(), opencode tearing down
    // the session, GC of an unread stream) to upstream abort. Without
    // this, cline keeps running until timeout AND the runner loop keeps
    // calling controller.enqueue on a closed controller, which throws.
    // The internal controller defers to options.abortSignal AND fires on
    // the ReadableStream's own cancel hook.
    const internalAbort = new AbortController()
    if (options.abortSignal) {
      if (options.abortSignal.aborted) internalAbort.abort()
      else options.abortSignal.addEventListener("abort", () => internalAbort.abort(), { once: true })
    }
    let streamCancelled = false

    // Capture `this` for use in the closure (stream start function)
    // Must be done before creating the ReadableStream to avoid TypeScript
    // inferring the wrong `this` type inside the start function.
    const thisInstance = this

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // Safe enqueue: silently drop after cancellation rather than
        // throwing "Invalid state: Controller is already closed". The
        // runner loop is async and may have one or two events in flight
        // when the consumer cancels.
        const safeEnqueue = (part: LanguageModelV3StreamPart) => {
          if (streamCancelled) return
          try {
            controller.enqueue(part)
          } catch {
            streamCancelled = true
          }
        }
        const safeClose = () => {
          if (streamCancelled) return
          streamCancelled = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }

        safeEnqueue({ type: "stream-start", warnings: [] })
        safeEnqueue({
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
          safeEnqueue({ type: "text-start", id })
          activeTextBlockId = id
          return id
        }
        const closeTextBlock = () => {
          if (activeTextBlockId === null) return
          safeEnqueue({ type: "text-end", id: activeTextBlockId })
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
        let emittedOpencodeCallCount = 0
        let duplicateCallCount = 0
        const parser = parserActive ? new OpencodeCallParser() : null
        const emitOpencodeCalls = (calls: ReadonlyArray<OpencodeCall>) => {
          for (const call of calls) {
            if (!registeredToolNames.has(call.toolName)) {
              // Registered-tool mismatch: don't dispatch — the host may not
              // have this tool in the current call. Surface the parsed body
              // as text so the user still sees what cline produced.
              const fallback = `<opencode-call name="${call.toolName}">${JSON.stringify(call.input)}</opencode-call>`
              const id = openTextBlock()
              safeEnqueue({ type: "text-delta", id, delta: fallback })
              continue
            }
            // Check for duplicate tool-calls to prevent infinite loops
            if (isDuplicateToolCall(thisInstance.previousToolCalls, call.toolName, call.input)) {
              duplicateCallCount++
              continue
            }
            trackToolCall(thisInstance.previousToolCalls, call.toolName, call.input, ClineLanguageModel.MAX_TOOL_CALL_CACHE)
            closeTextBlock()
            safeEnqueue({
              type: "tool-call",
              toolCallId: cryptoToolCallId(),
              toolName: call.toolName,
              input: JSON.stringify(call.input),
            })
            emittedOpencodeCallCount++
          }
        }
        try {
          for await (const ev of streamFn({
            prompt: promptText,
            options: { command, timeoutMs, extraArgs, cwd, env },
            signal: internalAbort.signal,
          })) {
            if (streamCancelled) break
            if (ev.type === "text-delta") {
              if (parser !== null) {
                const out = parser.feed(ev.delta)
                if (out.text.length > 0) {
                  const id = openTextBlock()
                  safeEnqueue({ type: "text-delta", id, delta: out.text })
                }
                if (out.calls.length > 0) emitOpencodeCalls(out.calls)
              } else {
                const id = openTextBlock()
                safeEnqueue({ type: "text-delta", id, delta: ev.delta })
              }
            } else if (ev.type === "tool-call") {
              closeTextBlock()
              // Bridge a cline-side tool invocation to opencode's stream.
              // cline already ran the tool, so we surface it as
              // provider-executed: opencode shows the call + result in
              // the UI but does NOT re-execute.
              //
              // ALL bridged tools (including read) are marked
              // providerExecuted to prevent infinite re-invocation loops.
              // Previously read was left unflagged so opencode would
              // re-run it for the LSP.touchFile() side effect, but that
              // caused opencode to loop indefinitely when cline read
              // files as part of its normal workflow.
              safeEnqueue({
                type: "tool-call",
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                input: JSON.stringify(ev.input),
                providerExecuted: true,
              })
            } else if (ev.type === "tool-result") {
              safeEnqueue({
                type: "tool-result",
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                result: ev.result as Awaited<ReturnType<LanguageModelV3["doStream"]>> extends infer _
                  ? Record<string, unknown>
                  : never,
                ...(ev.isError === true ? { isError: true } : {}),
              } as LanguageModelV3StreamPart)
            } else if (ev.type === "finish") {
              usage = ev.usage
              parseErrors = ev.parseErrors
            } else if (ev.type === "error") {
              throw ev.error
            }
          }
          // Flush any buffered tail before closing the text block. This
          // covers the case where cline ended mid-tag (partial open marker)
          // — we surface the fragment as text rather than dropping it.
          if (parser !== null) {
            const tail = parser.flush()
            if (tail.text.length > 0) {
              const id = openTextBlock()
              safeEnqueue({ type: "text-delta", id, delta: tail.text })
            }
          }
          closeTextBlock()
          // finishReason logic:
          //   - opencode-calls extracted → "tool-calls": opencode dispatches
          //     and re-enters cline on the next turn with tool-result.
          //   - cline-side bridged tool-calls (read/bash/grep/…) are all
          //     marked providerExecuted so they never cause re-invocation.
          //   - no tool-calls of any kind → "stop": normal terminal answer.
          //   - duplicate tool-calls filtered → "stop": prevent infinite loops
          //     when cline keeps generating the same tool-call repeatedly.
          safeEnqueue({
            type: "finish",
            finishReason: emittedOpencodeCallCount > 0
              ? { unified: "tool-calls", raw: undefined }
              : { unified: "stop", raw: duplicateCallCount > 0 ? "duplicate-tool-calls-filtered" : undefined },
            usage: toV3Usage(usage),
            providerMetadata: {
              cline: { parseErrors, modelLabel: modelId, opencodeCalls: emittedOpencodeCallCount, duplicateCallCount },
            },
          })
          safeClose()
        } catch (err) {
          // Flush parser BEFORE emitting the error so any buffered partial
          // tag is surfaced as text — matches the success-path philosophy
          // ("partial output never silently disappears") and keeps the
          // user from losing prose that was already in flight when cline
          // crashed mid-tag.
          if (parser !== null) {
            const tail = parser.flush()
            if (tail.text.length > 0) {
              const id = openTextBlock()
              safeEnqueue({ type: "text-delta", id, delta: tail.text })
            }
          }
          closeTextBlock()
          safeEnqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          safeClose()
        }
      },
      cancel() {
        // Consumer cancelled (reader.cancel(), session teardown, GC). Mark
        // the stream cancelled so the runner loop's safeEnqueue calls
        // become no-ops, and abort the upstream cline subprocess so it
        // doesn't keep running until the global timeout.
        streamCancelled = true
        internalAbort.abort()
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

function cryptoToolCallId(): string {
  return `cline-call-${randomUUID()}`
}

/**
 * Project `options.tools` (LanguageModelV3CallOptions) onto the minimal shape
 * the handoff builder and parser allow-list use. opencode passes a mix of
 * function tools and provider tools; we only care about the `.name` of
 * function tools. Provider tools come through as a different shape — guard
 * with a typeof check so we never read a missing field.
 */
function extractTools(options: LanguageModelV3CallOptions): ProtocolToolDescriptor[] {
  const tools = options.tools
  if (!tools || tools.length === 0) return []
  const out: ProtocolToolDescriptor[] = []
  for (const t of tools) {
    const name = (t as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) out.push({ name })
  }
  return out
}

function registeredSupportedToolNames(tools: readonly ProtocolToolDescriptor[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const tool of tools) {
    if (SUPPORTED_OPENCODE_CALL_TOOLS.has(tool.name)) names.add(tool.name)
  }
  return names
}

/**
 * One-shot variant of OpencodeCallParser for the doGenerate path, where we
 * already have the full text. Returns the cleaned text plus any complete
 * tool-calls. Partial / malformed fragments are surfaced as text (same
 * fallback as the streaming parser) so nothing silently disappears.
 */
/**
 * Slash-command bypass (doGenerate path). When the prompt contains a
 * `<command-instruction>` block whose text says "Run the <X> skill workflow"
 * AND the `skill` tool is registered for this turn, return a synthetic
 * GenerateResult that emits a single `skill` tool-call. opencode picks
 * it up, runs the skill, and resumes us on the next turn with SKILL.md
 * already loaded into the conversation.
 *
 * Returns null when no bypass applies — caller proceeds with the normal
 * cline subprocess path.
 */
type SkillBypassSource = "slash" | "natural-language"

function bypassMetadata(skillName: string, modelId: string, source: SkillBypassSource) {
  return {
    cline: {
      opencodeCalls: 1,
      // Legacy field name kept for downstream consumers that already
      // read it — set on both slash and natural-language bypass so
      // they don't lose telemetry signal when the source widens.
      skillSlashBypass: skillName,
      skillBypassSource: source,
      modelLabel: modelId,
    },
  }
}

function bypassFinishRaw(source: SkillBypassSource): string {
  return source === "slash" ? "skill-slash-bypass" : "skill-natural-language-bypass"
}

/**
 * doGenerate-side bypass. Given a resolved skill name (from either the
 * slash-command detector or the natural-language detector), returns a
 * synthetic GenerateResult that emits a single `skill` tool-call so
 * opencode dispatches and resumes us with SKILL.md already loaded.
 * Returns null when no bypass applies.
 */
function maybeResolveSkillBypass(
  skillName: string | null,
  tools: readonly ProtocolToolDescriptor[],
  modelId: string,
  source: SkillBypassSource,
  handoffText: string,
): Awaited<ReturnType<LanguageModelV3["doGenerate"]>> | null {
  if (skillName === null) return null
  if (!tools.some((t) => t.name === "skill")) return null
  // Loop guard: if THIS skill was already dispatched earlier in the
  // conversation (opencode resumed us with the prior tool-result), the
  // user's <command-instruction> directive is stale — emitting another
  // skill tool-call would loop forever. See
  // isSkillAlreadyDispatchedInHandoff for the byte-level detection.
  if (isSkillAlreadyDispatchedInHandoff(handoffText, skillName)) return null
  const toolCallId = cryptoToolCallId()
  const content = [
    {
      type: "tool-call" as const,
      toolCallId,
      toolName: "skill",
      input: JSON.stringify({ name: skillName }),
    },
  ]
  return {
    content: content as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>["content"],
    finishReason: { unified: "tool-calls", raw: bypassFinishRaw(source) },
    usage: toV3Usage({
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: undefined,
    }),
    warnings: [],
    response: {
      id: cryptoRandomId(),
      timestamp: new Date(),
      modelId,
    },
    providerMetadata: bypassMetadata(skillName, modelId, source),
  }
}

/**
 * doStream-side counterpart of `maybeResolveSkillBypass`. Wraps the
 * single skill tool-call + finish event in a one-shot ReadableStream.
 * cline is not spawned.
 */
function maybeResolveSkillBypassStream(
  skillName: string | null,
  tools: readonly ProtocolToolDescriptor[],
  modelId: string,
  source: SkillBypassSource,
  handoffText: string,
): Awaited<ReturnType<LanguageModelV3["doStream"]>> | null {
  if (skillName === null) return null
  if (!tools.some((t) => t.name === "skill")) return null
  if (isSkillAlreadyDispatchedInHandoff(handoffText, skillName)) return null
  const toolCallId = cryptoToolCallId()
  const responseId = cryptoRandomId()
  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({
        type: "response-metadata",
        id: responseId,
        timestamp: new Date(),
        modelId,
      })
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName: "skill",
        input: JSON.stringify({ name: skillName }),
      })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: bypassFinishRaw(source) },
        usage: toV3Usage({
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCost: undefined,
        }),
        providerMetadata: bypassMetadata(skillName, modelId, source),
      })
      controller.close()
    },
  })
  return { stream, response: { headers: {} } }
}

function parseOpencodeCallsOnce(text: string, registeredToolNames: ReadonlySet<string>): { text: string; calls: OpencodeCall[] } {
  const parser = new OpencodeCallParser()
  const out = parser.feed(text)
  const tail = parser.flush()
  const calls: OpencodeCall[] = []
  let visibleText = out.text + tail.text
  for (const call of [...out.calls, ...tail.calls]) {
    if (registeredToolNames.has(call.toolName)) {
      calls.push(call)
    } else {
      visibleText += `<opencode-call name="${call.toolName}">${JSON.stringify(call.input)}</opencode-call>`
    }
  }
  return { text: visibleText, calls }
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
