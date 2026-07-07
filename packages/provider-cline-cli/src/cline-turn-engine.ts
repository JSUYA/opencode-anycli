import { randomUUID } from "node:crypto"

import { runOnceAcp, runStreamAcp } from "./cline-acp-runner.js"
import { detectAcpSupport } from "./cline-capabilities.js"
import { composeClineHandoff } from "./cline-handoff.js"
import { runOnce, runStream, type RunInput, type StreamEvent } from "./cline-runner.js"
import {
  OpencodeCallParser,
  SUPPORTED_OPENCODE_CALL_TOOLS,
  detectSkillNaturalLanguageInHandoff,
  detectSkillSlashCommand,
  detectSubagentDispatchesInHandoff,
  expandOpencodeCall,
  isSkillAlreadyDispatchedInHandoff,
  type OpencodeCall,
  type ProtocolToolDescriptor,
} from "./opencode-call-parser.js"
import type { ClineMode, ClineUsage } from "./types.js"

export const DEFAULT_CLINE_TURN_TIMEOUT_MS = 3_600_000
export const DEFAULT_CLINE_TURN_MAX_TURNS = 15

export interface ClineTurnConfig {
  command?: string | undefined
  timeoutMs?: number | undefined
  extraArgs?: readonly string[] | undefined
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  mode?: ClineMode | undefined
}

export interface ClineTurnRequest {
  prompt: ReadonlyArray<unknown>
  tools?: readonly ProtocolToolDescriptor[] | undefined
  modelId: string
  signal?: AbortSignal | undefined
  config?: ClineTurnConfig | undefined
  previousToolCalls?: Set<string> | undefined
  maxTurns?: number | undefined
  runners?: ClineTurnRunners | undefined
}

export interface ClineTurnRunners {
  runStream?: ((input: RunInput) => AsyncIterable<StreamEvent>) | undefined
  runStreamAcp?: ((input: RunInput) => AsyncIterable<StreamEvent>) | undefined
  runOnce?: ((input: RunInput) => Promise<{ usage: ClineUsage; text: string; parseErrors: number }>) | undefined
  runOnceAcp?: ((input: RunInput) => Promise<{ usage: ClineUsage; text: string; parseErrors: number }>) | undefined
  detectAcpSupport?: ((command: string) => Promise<boolean>) | undefined
}

export type ClineTurnEvent =
  | { type: "reasoning-delta"; delta: string }
  | { type: "text-delta"; delta: string }
  | { type: "cline-tool"; toolName: string; summary: string }
  | { type: "opencode-call"; id: string; toolName: string; input: unknown }
  | { type: "finish"; usage: ClineUsage; finishReason: "stop" | "tool-calls"; raw?: string | undefined }
  | { type: "error"; error: Error }

export interface ClineTurnResult {
  text: string
  opencodeCalls: Array<{ id: string; toolName: string; input: unknown }>
  usage: ClineUsage
  finishReason: "stop" | "tool-calls"
  rawFinishReason?: string | undefined
}

export async function runClineTurnOnce(request: ClineTurnRequest): Promise<ClineTurnResult> {
  let text = ""
  const opencodeCalls: ClineTurnResult["opencodeCalls"] = []
  let usage = emptyClineUsage()
  let finishReason: ClineTurnResult["finishReason"] = "stop"
  let rawFinishReason: string | undefined

  for await (const event of runClineTurn(request)) {
    if (event.type === "text-delta") {
      text += event.delta
    } else if (event.type === "opencode-call") {
      opencodeCalls.push({ id: event.id, toolName: event.toolName, input: event.input })
    } else if (event.type === "finish") {
      usage = event.usage
      finishReason = event.finishReason
      rawFinishReason = event.raw
    } else if (event.type === "error") {
      throw event.error
    }
  }

  return { text, opencodeCalls, usage, finishReason, rawFinishReason }
}

export async function* runClineTurn(request: ClineTurnRequest): AsyncGenerator<ClineTurnEvent, void, void> {
  const tools = request.tools ?? []
  const handoff = composeClineHandoff({ prompt: request.prompt, tools })
  const handoffText = handoff.text
  const maxTurns = request.maxTurns ?? parseInt(process.env["OPENCODE_ANYCLI_MAX_TURNS"] ?? String(DEFAULT_CLINE_TURN_MAX_TURNS), 10)
  const currentTurns = countTurnsInPrompt(request.prompt)
  const registeredToolNames = registeredSupportedToolNames(tools)
  const previousToolCalls = request.previousToolCalls ?? new Set<string>()

  if (currentTurns >= maxTurns) {
    yield { type: "text-delta", delta: maxTurnsMessage(maxTurns) }
    yield { type: "finish", usage: emptyClineUsage(), finishReason: "stop", raw: "max-turns-reached" }
    return
  }

  const skillBypass = resolveSkillBypass(handoff.commandInstructions, handoffText, registeredToolNames)
  if (skillBypass !== null) {
    yield { type: "opencode-call", id: cryptoToolCallId(), toolName: "skill", input: { name: skillBypass } }
    yield { type: "finish", usage: emptyClineUsage(), finishReason: "tool-calls", raw: "skill-bypass" }
    return
  }

  const subagentDispatches = detectSubagentDispatchesInHandoff(handoffText)
  if (subagentDispatches.length > 0 && registeredToolNames.has("task")) {
    for (const dispatch of subagentDispatches) {
      yield {
        type: "opencode-call",
        id: cryptoToolCallId(),
        toolName: "task",
        input: {
          subagent_type: dispatch.subagent_type,
          description: dispatch.description,
          prompt: dispatch.prompt,
        },
      }
    }
    yield { type: "finish", usage: emptyClineUsage(), finishReason: "tool-calls", raw: "subagent-bypass" }
    return
  }

  const config = request.config ?? {}
  const command = config.command ?? "cline"
  const mode = await resolveClineMode(config.mode, command, request.runners?.detectAcpSupport)
  const timeoutMs = mode === "acp" ? 0 : (config.timeoutMs ?? DEFAULT_CLINE_TURN_TIMEOUT_MS)
  const streamFn = mode === "acp" ? (request.runners?.runStreamAcp ?? runStreamAcp) : (request.runners?.runStream ?? runStream)
  const parser = registeredToolNames.size > 0 ? new OpencodeCallParser() : null
  let usage = emptyClineUsage()
  let parseErrors = 0
  let emittedOpencodeCallCount = 0
  let duplicateCallCount = 0

  const emitCall = function* (call: OpencodeCall): Generator<ClineTurnEvent, void, void> {
    const expanded = expandOpencodeCall(call)
    const calls = expanded.length > 0 ? expanded : [call]
    for (const candidate of calls) {
      if (!registeredToolNames.has(candidate.toolName)) {
        yield {
          type: "text-delta",
          delta: `<opencode-call name="${candidate.toolName}">${JSON.stringify(candidate.input)}</opencode-call>`,
        }
        continue
      }

      if (isDuplicateToolCall(previousToolCalls, candidate.toolName, candidate.input)) {
        duplicateCallCount++
        continue
      }

      trackToolCall(previousToolCalls, candidate.toolName, candidate.input)
      emittedOpencodeCallCount++
      yield { type: "opencode-call", id: cryptoToolCallId(), toolName: candidate.toolName, input: candidate.input }
    }
  }

  try {
    for await (const event of streamFn({
      prompt: handoffText,
      usePromptFile: mode !== "acp",
      options: {
        command,
        timeoutMs,
        model: request.modelId,
        extraArgs: config.extraArgs,
        cwd: config.cwd,
        env: config.env,
      },
      signal: request.signal,
    })) {
      if (event.type === "reasoning-delta") {
        yield event
      } else if (event.type === "text-delta") {
        if (parser === null) {
          yield event
          continue
        }
        const out = parser.feed(event.delta)
        if (out.text.length > 0) yield { type: "text-delta", delta: out.text }
        for (const call of out.calls) yield* emitCall(call)
      } else if (event.type === "tool-call") {
        yield { type: "cline-tool", toolName: event.toolName, summary: event.toolName }
      } else if (event.type === "tool-result") {
        yield { type: "cline-tool", toolName: event.toolName, summary: event.isError ? "failed" : "completed" }
      } else if (event.type === "finish") {
        usage = event.usage
        parseErrors = event.parseErrors
      } else if (event.type === "error") {
        yield { type: "error", error: event.error }
      }
    }

    if (parser !== null) {
      const tail = parser.flush()
      if (tail.text.length > 0) yield { type: "text-delta", delta: tail.text }
      for (const call of tail.calls) yield* emitCall(call)
    }

    yield {
      type: "finish",
      usage,
      finishReason: emittedOpencodeCallCount > 0 ? "tool-calls" : "stop",
      raw: duplicateCallCount > 0 ? "duplicate-tool-calls-filtered" : parseErrors > 0 ? "parse-errors" : undefined,
    }
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export function emptyClineUsage(): ClineUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: undefined,
  }
}

export async function runClineTurnGenerate(request: ClineTurnRequest): Promise<ClineTurnResult> {
  const tools = request.tools ?? []
  const handoff = composeClineHandoff({ prompt: request.prompt, tools })
  const handoffText = handoff.text
  const config = request.config ?? {}
  const command = config.command ?? "cline"
  const mode = await resolveClineMode(config.mode, command, request.runners?.detectAcpSupport)
  const runner = mode === "acp" ? (request.runners?.runOnceAcp ?? runOnceAcp) : (request.runners?.runOnce ?? runOnce)
  const result = await runner({
    prompt: handoffText,
    usePromptFile: mode !== "acp",
    options: {
      command,
      timeoutMs: mode === "acp" ? 0 : (config.timeoutMs ?? DEFAULT_CLINE_TURN_TIMEOUT_MS),
      model: request.modelId,
      extraArgs: config.extraArgs,
      cwd: config.cwd,
      env: config.env,
    },
    signal: request.signal,
  })

  return { text: result.text, opencodeCalls: [], usage: result.usage, finishReason: "stop" }
}

function resolveSkillBypass(
  commandInstructions: readonly string[],
  handoffText: string,
  registeredToolNames: ReadonlySet<string>,
): string | null {
  if (!registeredToolNames.has("skill")) return null

  const slashSkill = detectSkillSlashCommand(commandInstructions)
  if (slashSkill !== null && !isSkillAlreadyDispatchedInHandoff(handoffText, slashSkill)) return slashSkill

  const naturalLanguageSkill = detectSkillNaturalLanguageInHandoff(handoffText)
  if (naturalLanguageSkill !== null && !isSkillAlreadyDispatchedInHandoff(handoffText, naturalLanguageSkill)) {
    return naturalLanguageSkill
  }

  return null
}

async function resolveClineMode(
  mode: ClineMode | undefined,
  command: string,
  detect: ((command: string) => Promise<boolean>) | undefined,
): Promise<"acp" | "subprocess"> {
  if (mode === "passthrough") throw new Error("Passthrough mode is not implemented for the OpenAI-compatible facade")
  if (mode === "acp") return "acp"
  if (mode === "subprocess") return "subprocess"
  return (await (detect ?? detectAcpSupport)(command)) ? "acp" : "subprocess"
}

function countTurnsInPrompt(prompt: ReadonlyArray<unknown>): number {
  let turnsSinceLastUser = 0
  for (const message of prompt) {
    if (typeof message !== "object" || message === null) continue
    const role = (message as Record<string, unknown>)["role"]
    if (role === "user") turnsSinceLastUser = 0
    else if (role === "assistant") turnsSinceLastUser++
  }
  return turnsSinceLastUser
}

function registeredSupportedToolNames(tools: readonly ProtocolToolDescriptor[]): Set<string> {
  const out = new Set<string>()
  for (const tool of tools) {
    if (SUPPORTED_OPENCODE_CALL_TOOLS.has(tool.name)) out.add(tool.name)
  }
  return out
}

function createToolCallSignature(toolName: string, input: unknown): string {
  try {
    const sortedInput = JSON.stringify(input, Object.keys((input ?? {}) as object).sort())
    return JSON.stringify({ toolName, input: sortedInput })
  } catch {
    return JSON.stringify({ toolName, input: String(input) })
  }
}

function isDuplicateToolCall(previousToolCalls: Set<string>, toolName: string, input: unknown): boolean {
  return previousToolCalls.has(createToolCallSignature(toolName, input))
}

function trackToolCall(previousToolCalls: Set<string>, toolName: string, input: unknown): void {
  previousToolCalls.add(createToolCallSignature(toolName, input))
  if (previousToolCalls.size <= 200) return
  const first = previousToolCalls.values().next().value
  if (first !== undefined) previousToolCalls.delete(first)
}

function maxTurnsMessage(maxTurns: number): string {
  return `[opencode-anycli] Maximum turns (${maxTurns}) reached. Stopping to prevent infinite loop. Use OPENCODE_ANYCLI_MAX_TURNS env var to increase limit if needed.`
}

function cryptoToolCallId(): string {
  return `cline-call-${randomUUID()}`
}
