// NDJSON parser for cline's stdout stream.
//
// cline emits one JSON object per line. This module provides:
//   - parseLine(line): defensive single-line parser → returns ClineEvent | null
//   - createNdjsonSplitter(): a stateful splitter that yields complete lines as a Buffer-style stream arrives
//
// We deliberately use `unknown` instead of `any` and validate with hand-rolled type guards.

import type { AgentEventBody, ClineEvent } from "./types.js"

const DEBUG = process.env["DEBUG"] === "1"

/** Stateful line splitter — feed it chunks, get back complete lines. */
export function createNdjsonSplitter(): {
  push: (chunk: string) => string[]
  flush: () => string[]
} {
  let buffer = ""
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const out: string[] = []
      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.length > 0) out.push(line)
      }
      return out
    },
    flush(): string[] {
      const remaining = buffer.trim()
      buffer = ""
      return remaining.length > 0 ? [remaining] : []
    },
  }
}

/**
 * Parse a single NDJSON line into a recognized ClineEvent, or null if the line
 * is not valid JSON / not an object. Logs to stderr at DEBUG level on failure.
 */
export function parseLine(line: string): ClineEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (err) {
    if (DEBUG) process.stderr.write(`[ndjson] failed to parse line: ${line.slice(0, 200)}\n`)
    return null
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (DEBUG) process.stderr.write(`[ndjson] line is not an object: ${line.slice(0, 200)}\n`)
    return null
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj["type"] !== "string") {
    if (DEBUG) process.stderr.write(`[ndjson] missing string 'type': ${line.slice(0, 200)}\n`)
    return null
  }
  return obj as ClineEvent
}

/**
 * Type guards for the events we care about. Each accepts an unvalidated event and
 * narrows it. Anything that doesn't match returns false.
 */
export function isSayText(e: ClineEvent): e is { type: "say"; say: "text"; text?: string; partial?: boolean } {
  return e.type === "say" && (e as { say?: unknown }).say === "text"
}

export function isSayCompletion(
  e: ClineEvent,
): e is { type: "say"; say: "completion_result"; text?: string; partial?: boolean } {
  return e.type === "say" && (e as { say?: unknown }).say === "completion_result"
}

export function isSayReasoning(e: ClineEvent): e is { type: "say"; say: "reasoning"; text?: string; partial?: boolean } {
  return e.type === "say" && (e as { say?: unknown }).say === "reasoning"
}

export function isApiReqFinished(
  e: ClineEvent,
): e is {
  type: "say"
  say: "api_req_finished"
  text?: string
  tokensIn?: number
  tokensOut?: number
  cacheWrites?: number
  cacheReads?: number
  cost?: number
} {
  return e.type === "say" && (e as { say?: unknown }).say === "api_req_finished"
}

export function isApiReqStarted(e: ClineEvent): e is { type: "say"; say: "api_req_started"; text?: string; ts?: number } {
  return e.type === "say" && (e as { say?: unknown }).say === "api_req_started"
}

export function isTaskStarted(e: ClineEvent): boolean {
  return e.type === "task_started"
}

/** Current-schema lifecycle event from cline's plugin hook bus. */
export function isHookEvent(e: ClineEvent): e is { type: "hook_event"; hookEventName?: string; taskId?: string } {
  return e.type === "hook_event"
}

/** Current-schema event envelope; sub-shape lives under `event`. */
export function isAgentEvent(e: ClineEvent): e is { type: "agent_event"; event?: AgentEventBody } {
  return e.type === "agent_event"
}

/** Current-schema terminal event carrying final/aggregate usage. */
export function isRunResult(e: ClineEvent): boolean {
  return e.type === "run_result"
}

/** Top-level cline error event. */
export function isErrorEvent(e: ClineEvent): e is { type: "error"; message?: string } {
  return e.type === "error"
}

/** Pull the sub-event body out of an `agent_event` envelope, if present. */
export function agentEventBody(e: ClineEvent): AgentEventBody | null {
  if (e.type !== "agent_event") return null
  const body = (e as { event?: unknown }).event
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const inner = body as Record<string, unknown>
  if (typeof inner["type"] !== "string") return null
  return body as AgentEventBody
}

/** Get the `text` field if it's a non-empty string. */
export function pickText(e: ClineEvent): string | null {
  const t = (e as { text?: unknown }).text
  return typeof t === "string" && t.length > 0 ? t : null
}

/** True if a `partial` flag is present and set to true. */
export function isPartial(e: ClineEvent): boolean {
  return (e as { partial?: unknown }).partial === true
}
