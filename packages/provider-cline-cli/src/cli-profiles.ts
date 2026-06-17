// Per-CLI launch profiles for the claude / codex flavors.
//
// claude and codex have no native ACP transport, so we drive them as plain
// subprocesses that stream line-delimited JSON on stdout — structurally the
// same shape cline's NDJSON subprocess mode already uses. This module owns:
//
//   1. the model registry (opencode model id -> CLI model + reasoning effort)
//   2. the argv builder per flavor (including the yolo permission bypass)
//   3. the per-flavor stdout line parser (CLI JSON event -> StreamEvent)
//
// The prompt is delivered on stdin (not argv), so there is no ARG_MAX / E2BIG
// ceiling regardless of conversation length — both CLIs read their prompt from
// stdin when no positional prompt is given.

import type { CliFlavor, ClineUsage } from "./types.js"
import type { StreamEvent } from "./cline-runner.js"

/** Reasoning-effort levels both CLIs understand (claude also accepts these as `--effort`). */
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])

export interface CliModelDef {
  /** Value passed to the CLI's own model flag (claude `--model`, codex `-m`). */
  model: string
  /** Reasoning effort level (claude `--effort`, codex `model_reasoning_effort`). */
  effort: string
}

/**
 * Built-in model registry keyed by the opencode-facing model id. These ids are
 * the same ones declared under `provider.<name>.models` in opencode.json. When
 * opencode asks for a model id not listed here we derive a best-effort def from
 * the id itself (see {@link deriveModelDef}).
 */
export const CLAUDE_MODELS: Record<string, CliModelDef> = {
  "opus-4.8-high": { model: "opus", effort: "high" },
  "opus-4.8-xhigh": { model: "opus", effort: "xhigh" },
  "opus-4.8-max": { model: "opus", effort: "max" },
}

export const CODEX_MODELS: Record<string, CliModelDef> = {
  "gpt-5.5-high": { model: "gpt-5.5", effort: "high" },
  "gpt-5.5-xhigh": { model: "gpt-5.5", effort: "xhigh" },
}

/** Fallback binary name when `options.command` is not set. */
export const DEFAULT_COMMAND: Record<Exclude<CliFlavor, "cline">, string> = {
  claude: "claude",
  codex: "codex",
}

/**
 * Resolve a model id into { model, effort }. Prefers the registry; otherwise
 * splits a trailing effort token off the id (e.g. "opus-4.8-max" -> model
 * "opus-4.8", effort "max"). Keeps the provider usable if a user adds custom
 * model entries to opencode.json without touching this file.
 */
export function deriveModelDef(flavor: Exclude<CliFlavor, "cline">, modelId: string): CliModelDef {
  const registry = flavor === "claude" ? CLAUDE_MODELS : CODEX_MODELS
  const known = registry[modelId]
  if (known) return known

  const lastDash = modelId.lastIndexOf("-")
  if (lastDash > 0) {
    const tail = modelId.slice(lastDash + 1)
    if (EFFORT_LEVELS.has(tail)) {
      return { model: modelId.slice(0, lastDash), effort: tail }
    }
  }
  // No recognizable effort suffix: pass the whole id as the model and let the
  // CLI apply its own default effort.
  return { model: modelId, effort: flavor === "codex" ? "high" : "high" }
}

export interface ParsedLine {
  /** Stream parts to forward (text deltas only — finish is emitted by the runner on close). */
  events: StreamEvent[]
  /** Latest usage snapshot, if this line carried one. Runner keeps the newest. */
  usage?: ClineUsage
  /** Upstream context-window size, if the line reported one. */
  contextMax?: number
  /** Set when the CLI reported a fatal turn failure — runner surfaces it as an error. */
  fatalError?: string
}

export type CliLineParser = (obj: unknown) => ParsedLine

export interface CliRunProfile {
  command: string
  /** argv WITHOUT the prompt — the prompt is written to stdin. */
  args: string[]
  parseLine: CliLineParser
  /** Human label for error messages, e.g. "claude" / "codex". */
  label: string
}

/**
 * Build the launch profile for a claude/codex run. `extraArgs` is appended
 * after the flavor's own flags so users can add `provider.options.extraArgs`.
 */
export function resolveCliRunProfile(
  flavor: Exclude<CliFlavor, "cline">,
  modelId: string,
  command: string,
  extraArgs: readonly string[] = [],
): CliRunProfile {
  const def = deriveModelDef(flavor, modelId)
  if (flavor === "claude") {
    return {
      command,
      label: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        def.model,
        "--effort",
        def.effort,
        // yolo: skip every permission prompt so the CLI runs autonomously,
        // matching cline's always-on `--yolo`.
        "--permission-mode",
        "bypassPermissions",
        ...extraArgs,
      ],
      parseLine: parseClaudeLine,
    }
  }
  // codex
  return {
    command,
    label: "codex",
    args: [
      "exec",
      "--json",
      "-m",
      def.model,
      "-c",
      `model_reasoning_effort=${def.effort}`,
      // yolo: bypass approvals + sandbox so commands run without prompting,
      // matching cline's always-on `--yolo`.
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      ...extraArgs,
    ],
    parseLine: parseCodexLine,
  }
}

// ─── claude stream-json parser ──────────────────────────────────────────────
// Event shapes (claude -p --output-format stream-json --include-partial-messages):
//   {"type":"stream_event","event":{"type":"content_block_delta",
//       "delta":{"type":"text_delta","text":"h"}}}
//   {"type":"stream_event","event":{"type":"message_delta","usage":{...}}}
//   {"type":"result","subtype":"success","result":"hi","total_cost_usd":...,
//       "usage":{input_tokens,output_tokens,cache_read_input_tokens,
//                cache_creation_input_tokens},
//       "modelUsage":{"<model>":{"contextWindow":1000000,...}}}

function parseClaudeLine(obj: unknown): ParsedLine {
  const o = asRecord(obj)
  if (!o) return { events: [] }
  const type = o["type"]

  if (type === "stream_event") {
    const ev = asRecord(o["event"])
    if (!ev) return { events: [] }
    const evType = ev["type"]
    if (evType === "content_block_delta") {
      const delta = asRecord(ev["delta"])
      if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        return { events: [{ type: "text-delta", delta: delta["text"] as string }] }
      }
      return { events: [] }
    }
    if (evType === "message_start") {
      const message = asRecord(ev["message"])
      const usage = message ? claudeUsage(asRecord(message["usage"])) : undefined
      return usage ? { events: [], usage } : { events: [] }
    }
    if (evType === "message_delta") {
      const usage = claudeUsage(asRecord(ev["usage"]))
      return usage ? { events: [], usage } : { events: [] }
    }
    return { events: [] }
  }

  if (type === "result") {
    const usage = claudeUsage(asRecord(o["usage"]))
    if (usage && typeof o["total_cost_usd"] === "number") usage.totalCost = o["total_cost_usd"] as number
    const contextMax = firstContextWindow(asRecord(o["modelUsage"]))
    const fatalError = o["is_error"] === true ? claudeErrorText(o) : undefined
    return { events: [], ...(usage ? { usage } : {}), ...(contextMax ? { contextMax } : {}), ...(fatalError ? { fatalError } : {}) }
  }

  return { events: [] }
}

function claudeUsage(u: Record<string, unknown> | null): ClineUsage | undefined {
  if (!u) return undefined
  const input = num(u["input_tokens"])
  const output = num(u["output_tokens"])
  const cacheRead = num(u["cache_read_input_tokens"])
  const cacheWrite = num(u["cache_creation_input_tokens"])
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output,
    totalCost: undefined,
  }
}

function claudeErrorText(o: Record<string, unknown>): string {
  if (typeof o["result"] === "string" && o["result"]) return o["result"] as string
  if (typeof o["subtype"] === "string") return `claude error: ${o["subtype"] as string}`
  return "claude reported an error"
}

function firstContextWindow(modelUsage: Record<string, unknown> | null): number | undefined {
  if (!modelUsage) return undefined
  for (const value of Object.values(modelUsage)) {
    const rec = asRecord(value)
    if (rec && typeof rec["contextWindow"] === "number" && rec["contextWindow"] > 0) {
      return rec["contextWindow"] as number
    }
  }
  return undefined
}

// ─── codex exec --json parser ───────────────────────────────────────────────
// Event shapes (codex exec --json):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"type":"agent_message","text":"hi"}}
//   {"type":"item.completed","item":{"type":"reasoning",...}}        (ignored)
//   {"type":"item.completed","item":{"type":"error","message":"..."}} (non-fatal warning)
//   {"type":"turn.completed","usage":{input_tokens,output_tokens,
//        cached_input_tokens,reasoning_output_tokens}}
//   {"type":"turn.failed","error":{"message":"..."}}

function parseCodexLine(obj: unknown): ParsedLine {
  const o = asRecord(obj)
  if (!o) return { events: [] }
  const type = o["type"]

  if (type === "item.completed") {
    const item = asRecord(o["item"])
    if (item && item["type"] === "agent_message" && typeof item["text"] === "string") {
      return { events: [{ type: "text-delta", delta: item["text"] as string }] }
    }
    // reasoning / command_execution / file_change / error items: codex runs and
    // reports these internally; we don't surface them as opencode stream parts.
    return { events: [] }
  }

  if (type === "turn.completed") {
    const usage = codexUsage(asRecord(o["usage"]))
    return usage ? { events: [], usage } : { events: [] }
  }

  if (type === "turn.failed") {
    const err = asRecord(o["error"])
    const message = err && typeof err["message"] === "string" ? (err["message"] as string) : "codex turn failed"
    return { events: [], fatalError: message }
  }

  return { events: [] }
}

function codexUsage(u: Record<string, unknown> | null): ClineUsage | undefined {
  if (!u) return undefined
  const input = num(u["input_tokens"])
  const output = num(u["output_tokens"]) + num(u["reasoning_output_tokens"])
  const cacheRead = num(u["cached_input_tokens"])
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: input + output,
    totalCost: undefined,
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
