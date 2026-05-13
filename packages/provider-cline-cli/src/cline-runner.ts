// Subprocess management for the cline CLI.
//
// Spawns `cline --json --yolo --act "<prompt>"` and parses NDJSON events from stdout.
// The runner exposes two entry points:
//
//   runOnce(opts) → Promise<RunResult>            — buffer mode for doGenerate
//   runStream(opts) → AsyncIterable<StreamEvent>  — incremental mode for doStream
//
// Both share the same spawn / parse plumbing.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  agentEventBody,
  createNdjsonSplitter,
  parseLine,
  isAgentEvent,
  isApiReqFinished,
  isApiReqStarted,
  isErrorEvent,
  isHookEvent,
  isPartial,
  isRunResult,
  isTaskStarted,
  pickText,
} from "./ndjson-parser.js"
import {
  buildPromptFileWrapper,
  deletePromptTempFile,
  shouldUsePromptFile,
  writePromptTempFile,
} from "./prompt-tempfile.js"
import type { ClineEvent, ClineUsage, RunResult } from "./types.js"

const DEBUG = process.env["DEBUG"] === "1"

/**
 * Append every raw NDJSON line cline emits to this path. Used to debug
 * "tokens not collected" reports — we capture the unparsed stream so we
 * can diff it against our event guards offline.
 */
const NDJSON_LOG = process.env["OPENCODE_ANYCLI_CLINE_NDJSON_LOG"] ?? null

function appendNdjsonLog(line: string): void {
  if (NDJSON_LOG === null) return
  try {
    appendFileSync(NDJSON_LOG, line + "\n", "utf8")
  } catch {
    /* diagnostic logging must never break a model call */
  }
}

const VISIBLE_SAY_TEXT_KINDS = new Set([
  "text",
  "completion_result",
  "tool",
  "command_output",
  "error",
  "error_retry",
  "diff_error",
  "clineignore_error",
  "hook_status",
  "info",
  "shell_integration_warning",
  "shell_integration_warning_with_suggestion",
  "checkpoint_created",
  "load_mcp_documentation",
  "mcp_notification",
  "deleted_api_reqs",
  "api_req_retried",
  "command_permission_denied",
  "generate_explanation",
  "conditional_rules_applied",
])

const VISIBLE_ASK_TEXT_KINDS = new Set([
  "followup",
  "plan_mode_respond",
  "completion_result",
  "resume_task",
  "resume_completed_task",
  "new_task",
  "condense",
  "summarize_task",
  "report_bug",
  "api_req_failed",
  "mistake_limit_reached",
  "command_output",
])

export interface RunInput {
  prompt: string
  options: {
    command: string
    timeoutMs: number
    extraArgs?: readonly string[] | undefined
    cwd?: string | undefined
    env?: Record<string, string> | undefined
  }
  signal?: AbortSignal | undefined
  /**
   * Test seam: override `child_process.spawn` so unit tests can inject a fake.
   * When supplied, called instead of the real spawn().
   */
  spawnFn?: typeof spawn | undefined
}

export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      result: Record<string, unknown>
      isError?: boolean
    }
  | { type: "finish"; usage: RunResult["usage"]; parseErrors: number }
  | { type: "error"; error: Error }

/**
 * Tool name we surface to opencode for cline's readFile activity.
 *
 * Empirically, opencode silently drops `tool-call` stream parts for tool
 * names it has not registered locally (verified via session_message
 * inspection — only `text` parts survived an unknown name). So we reuse
 * opencode's built-in `read` tool name and rely on `providerExecuted: true`
 * to bypass its execute path while still letting its renderer surface the
 * "Read <path>" entry in the timeline.
 */
export const CLINE_READ_TOOL_NAME = "read"

type VisibleText = {
  channel: string
  text: string
}

/** Build the CLI arg list for cline. */
export function buildClineArgs(prompt: string, extraArgs: readonly string[] = []): string[] {
  return ["--json", "--yolo", "--act", prompt, ...extraArgs]
}

/** Buffered runner — collects all text and returns once cline exits or completes. */
export async function runOnce(input: RunInput): Promise<RunResult> {
  let finalText = ""
  let usage = emptyUsage()
  let parseErrors = 0

  for await (const ev of runStreamInternal(input)) {
    if (ev.type === "text-delta") {
      finalText += ev.delta
    } else if (ev.type === "tool-call") {
      // Render readFile tool-calls as a short textual marker so consumers
      // that only look at result.text (doGenerate) still see what cline read.
      finalText += renderToolCallAsText(ev) ?? ""
    } else if (ev.type === "tool-result") {
      // No additional text — the tool-call line above already named the file.
    } else if (ev.type === "finish") {
      usage = ev.usage
      parseErrors = ev.parseErrors
    } else if (ev.type === "error") {
      throw ev.error
    }
  }

  return { text: finalText, usage, parseErrors }
}

function renderToolCallAsText(ev: { toolName: string; input: Record<string, unknown> }): string | null {
  if (ev.toolName !== CLINE_READ_TOOL_NAME) return null
  const filePath = typeof ev.input["filePath"] === "string" ? (ev.input["filePath"] as string) : null
  if (!filePath) return null
  const start = typeof ev.input["offset"] === "number" ? (ev.input["offset"] as number) : undefined
  const limit = typeof ev.input["limit"] === "number" ? (ev.input["limit"] as number) : undefined
  const end = start !== undefined && limit !== undefined ? start + limit - 1 : undefined
  const range = start !== undefined ? (end !== undefined && end !== start ? `:${start}-${end}` : `:${start}`) : ""
  return `[cline:readFile] ${filePath}${range}\n`
}

/** Streaming runner — yields incremental text deltas. */
export function runStream(input: RunInput): AsyncIterable<StreamEvent> {
  return runStreamInternal(input)
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function* runStreamInternal(input: RunInput): AsyncGenerator<StreamEvent, void, void> {
  const { prompt, options, signal } = input
  const spawnImpl = input.spawnFn ?? spawn

  // E2BIG avoidance: prompts larger than argvSafeLimitBytes() are spilled to
  // a temp file; cline receives a small wrapper asking it to read the file.
  // Works on every cline version because we still go through the standard
  // --act path. See prompt-tempfile.ts for the rationale.
  let tempPromptFile: string | null = null
  let effectivePrompt = prompt
  if (shouldUsePromptFile(prompt)) {
    try {
      tempPromptFile = await writePromptTempFile(prompt)
      effectivePrompt = buildPromptFileWrapper(tempPromptFile)
      if (DEBUG)
        process.stderr.write(
          `[cline-runner] prompt spilled to ${tempPromptFile} (${Buffer.byteLength(prompt, "utf8")} bytes)\n`,
        )
    } catch (err) {
      yield { type: "error", error: wrapErr(err, "Failed to write prompt temp file") }
      return
    }
  }
  const args = buildClineArgs(effectivePrompt, options.extraArgs)

  const env = {
    ...process.env,
    ...(options.env ?? {}),
  }

  // stdin handling — TTY-on by default:
  //   - default "inherit": cline shares the parent's stdin file descriptor.
  //     If the parent's stdin is a TTY, cline (and any bash subprocess it
  //     spawns) can prompt the user interactively — required for `sudo`
  //     password prompts, `ssh-add`, `gh auth login`, etc. opencode pauses
  //     I/O during provider calls in our observed behaviour, so this does
  //     not race the TUI.
  //   - "ignore" (env OPENCODE_ANYCLI_TTY=0 or --no-tty): cline cannot
  //     read from the parent terminal. Use this for non-interactive CI
  //     runs where you want cline isolated, or to suppress accidental
  //     stdin consumption from a piped parent.
  const ttyEnv = process.env["OPENCODE_ANYCLI_TTY"]
  const wantTty = ttyEnv !== "0" // default ON
  const stdin: "ignore" | "inherit" = wantTty ? "inherit" : "ignore"

  const cleanupTempPromptFile = () => {
    if (tempPromptFile !== null) {
      const path = tempPromptFile
      tempPromptFile = null
      void deletePromptTempFile(path)
    }
  }

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnImpl(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: [stdin, "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams
  } catch (err) {
    cleanupTempPromptFile()
    yield { type: "error", error: wrapErr(err, `Failed to spawn cline (${options.command})`) }
    return
  }

  // Set up timeout / abort. Track WHY the child was killed so we can surface
  // a real error in `close` instead of silently emitting a finish event.
  let killReason: "timeout" | "abort" | null = null

  const timeoutHandle = setTimeout(() => {
    killReason = "timeout"
    if (DEBUG) process.stderr.write(`[cline-runner] timeout after ${options.timeoutMs}ms — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL")
    }, 2000).unref()
  }, options.timeoutMs)
  timeoutHandle.unref()

  const onAbort = () => {
    killReason = "abort"
    if (DEBUG) process.stderr.write(`[cline-runner] aborted — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
  }
  signal?.addEventListener("abort", onAbort)

  // Drain stderr to a debug log; we don't surface it as an error unless cline exits non-zero.
  const stderrChunks: string[] = []
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk)
    if (DEBUG) process.stderr.write(`[cline stderr] ${chunk}`)
  })

  // Track running text across the whole task. cline emits partial messages with
  // `partial:true` then a `partial:false` version, and often a final
  // `completion_result` that duplicates it. We emit only the new tail relative
  // to everything already streamed, so consumers get a single coherent stream.
  const emittedByChannel = new Map<string, string>()
  // Total characters streamed on the assistant channel. Used as a coarse
  // fallback to estimate output tokens when cline's provider (e.g. sr-proxy)
  // never reports them in any structured way. ~3 chars/token approximates
  // Korean/English mixed content well enough to give opencode a non-zero
  // signal for its "Context X tokens" panel.
  let assistantCharCount = 0
  let taskId: string | null = null
  // Each api_req_started / api_req_finished entry is a snapshot of the
  // SAME conversation's tokens after one API call. Some cline configs emit
  // both started and finished for the same call, or fire partial then
  // final variants — summing them inflates the count by 2× / 3×, which
  // showed up as "single-word prompt at 25% context" in the TUI. We track
  // the latest snapshot by `ts` instead and use that as the run's usage.
  let usage = emptyUsage()
  let latestUsageTs = -1
  // `run_result` / `agent_event.done` are the authoritative terminal usage
  // values in cline's current schema. Once one of them lands we stop
  // letting interim snapshots overwrite the picked value — otherwise an
  // unrelated late event with stale numbers could clobber the final total.
  let terminalUsageSeen = false
  let parseErrors = 0

  function emitTextIfNew(channel: string, text: string) {
    if (text.length === 0) return
    const totalEmitted = emittedByChannel.get(channel) ?? ""
    // Common case: this text extends what we've already streamed (cline partial → final).
    if (text.startsWith(totalEmitted)) {
      const delta = text.slice(totalEmitted.length)
      if (delta.length > 0) {
        enqueue({ type: "text-delta", delta })
        emittedByChannel.set(channel, text)
        if (channel === "assistant") assistantCharCount += delta.length
      }
      return
    }
    // Edge case: text is a new logical message that doesn't extend the prior one
    // (e.g. cline emits a second say.text after an unrelated event). Treat it as
    // a fresh segment and reset the running prefix to it — never append, which
    // would risk double-emission if the same prefix arrives again.
    enqueue({ type: "text-delta", delta: text })
    emittedByChannel.set(channel, text)
    if (channel === "assistant") assistantCharCount += text.length
  }

  const splitter = createNdjsonSplitter()
  child.stdout.setEncoding("utf8")

  // Pump stdout into a queue we can yield from.
  const queue: StreamEvent[] = []
  let resolveNext: (() => void) | null = null
  let done = false
  let exitErr: Error | null = null

  function enqueue(ev: StreamEvent) {
    queue.push(ev)
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  }

  function maybeUpdateUsage(ev: ClineEvent, next: ClineUsage, opts: { terminal?: boolean } = {}) {
    if (!hasTokenUsage(next)) return
    if (terminalUsageSeen && !opts.terminal) return
    const tsNum = pickTsNumber(ev) ?? latestUsageTs + 1
    if (!opts.terminal && tsNum < latestUsageTs) return
    latestUsageTs = tsNum
    usage = next
    if (opts.terminal) terminalUsageSeen = true
  }

  // Track readFile tool-calls we've already surfaced so partial→final
  // updates don't double-emit. Key: file path that goes into the call.
  const emittedReads = new Set<string>()

  function handleEvent(ev: ClineEvent) {
    if (isTaskStarted(ev)) {
      taskId = pickTaskId(ev) ?? taskId
      return
    }
    // Current-schema lifecycle envelope. Carries the legacy-style numeric
    // taskId on `agent_start`, which our persisted-file fallback uses.
    if (isHookEvent(ev)) {
      const hookTaskId = (ev as { taskId?: unknown }).taskId
      if (typeof hookTaskId === "string" && hookTaskId.length > 0) taskId = hookTaskId
      return
    }
    // Terminal events from the current schema — `run_result` is the last
    // line cline emits, `agent_event.done` arrives one event earlier.
    // Either way the embedded usage is the authoritative final total.
    if (isRunResult(ev)) {
      maybeUpdateUsage(ev, pickRunResultUsage(ev), { terminal: true })
      const text = pickStringField(ev, "text")
      const finishReason = pickStringField(ev, "finishReason")
      // run_result.text is the final assistant string. For the current
      // schema this is the ONLY place a clean final answer lands when
      // cline streamed via agent_event.content_start chunks but never
      // emitted a legacy say.text / completion_result. Only surface it
      // if nothing has been emitted on the assistant channel yet, to
      // avoid duplicating with the chunked content_start stream above.
      if (text && finishReason !== "error" && !emittedByChannel.has("assistant")) {
        emitTextIfNew("assistant", text)
      }
      return
    }
    if (isAgentEvent(ev)) {
      const body = agentEventBody(ev)
      if (body === null) return
      switch (body.type) {
        case "content_start": {
          // Each chunk is a discrete text delta — cline already split them
          // up. We DO NOT mirror to emitTextIfNew's prefix-tracking because
          // these chunks aren't cumulative.
          const contentType = (body as { contentType?: unknown }).contentType
          if (contentType !== undefined && contentType !== "text") return
          const text = (body as { text?: unknown }).text
          if (typeof text === "string" && text.length > 0) {
            enqueue({ type: "text-delta", delta: text })
            // Track that we've already streamed the assistant channel so
            // a duplicate full-text `run_result.text` doesn't re-emit it.
            emittedByChannel.set("assistant", (emittedByChannel.get("assistant") ?? "") + text)
            assistantCharCount += text.length
          }
          return
        }
        case "content_end":
          // `content_end` carries the FULL concatenated text — we already
          // streamed each chunk via `content_start`, so dropping it avoids
          // duplication. (Unlike say.text→completion_result in the legacy
          // schema, this end event is not an extension of the deltas.)
          return
        case "usage": {
          // Interim cumulative snapshot. Use totalInputTokens etc. when
          // present so consecutive iterations show the running total, not
          // the per-iteration delta.
          maybeUpdateUsage(ev, normalizeAgentUsage(body))
          return
        }
        case "done": {
          const u = normalizeAgentUsage((body as { usage?: unknown }).usage)
          maybeUpdateUsage(ev, u, { terminal: true })
          return
        }
        case "error": {
          const errBody = (body as { error?: { message?: unknown; name?: unknown } }).error
          const message = (typeof errBody?.message === "string" && errBody.message) ||
            (typeof errBody?.name === "string" && errBody.name) ||
            "cline agent error"
          enqueue({ type: "error", error: new Error(String(message)) })
          return
        }
        default:
          // iteration_start / iteration_end / other lifecycle markers —
          // informational. Drop.
          return
      }
    }
    if (isErrorEvent(ev)) {
      const message = pickStringField(ev, "message") ?? "cline reported an error"
      enqueue({ type: "error", error: new Error(message) })
      return
    }
    if (isApiReqStarted(ev) || isApiReqFinished(ev)) {
      const structured = pickUsage(ev)
      if (hasTokenUsage(structured)) {
        maybeUpdateUsage(ev, structured)
        return
      }
      // Fallback for cline providers (e.g. sr-proxy) that DO NOT populate
      // tokensIn/tokensOut in api_req_started.text — cline still embeds a
      // human-readable "# Context Window Usage\nN / M tokens used (P%)"
      // banner inside environment_details, which is the only place we can
      // recover the cumulative input-token count for these providers.
      const ctxUsage = pickContextWindowUsage(pickText(ev))
      if (ctxUsage !== null) maybeUpdateUsage(ev, ctxUsage)
      return
    }
    // Surface cline's readFile activity as a structured tool-call so opencode's
    // generic tool-part renderer can list it for the user. Skip partials —
    // the path doesn't stream incrementally and emitting on each partial
    // would duplicate the entry.
    const readCall = pickReadFileCall(ev)
    if (readCall !== null) {
      if (isPartial(ev)) return
      // Suppress reads of our own spill file — it's an implementation detail
      // (we wrote it and pointed cline at it; the user never asked for it).
      // Without this filter the path leaks into runOnce's text and shows up
      // as a phantom "Read /tmp/opencode-anycli-prompts/..." entry in the
      // session timeline.
      if (tempPromptFile !== null && readCall.filePath === tempPromptFile) return
      if (emittedReads.has(readCall.filePath)) return
      emittedReads.add(readCall.filePath)
      const toolCallId = `cline-read-${randomUUID()}`
      const input: Record<string, unknown> = { filePath: readCall.filePath }
      if (readCall.offset !== undefined) input["offset"] = readCall.offset
      if (readCall.limit !== undefined) input["limit"] = readCall.limit
      enqueue({ type: "tool-call", toolCallId, toolName: CLINE_READ_TOOL_NAME, input })
      enqueue({
        type: "tool-result",
        toolCallId,
        toolName: CLINE_READ_TOOL_NAME,
        result: { ok: true, filePath: readCall.filePath },
      })
      return
    }
    const visibleText = pickVisibleText(ev)
    if (visibleText !== null) {
      emitTextIfNew(visibleText.channel, visibleText.text)
      return
    }
    // Unknown event type — defensive ignore.
    if (DEBUG) process.stderr.write(`[cline-runner] unknown event type: ${ev.type}\n`)
  }

  child.stdout.on("data", (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      appendNdjsonLog(line)
      const ev = parseLine(line)
      if (ev === null) {
        parseErrors++
        continue
      }
      handleEvent(ev)
    }
  })

  child.on("error", (err) => {
    exitErr = wrapErr(err, "cline subprocess error")
    cleanupTempPromptFile()
    done = true
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  })

  child.on("close", (code, sigterm) => {
    clearTimeout(timeoutHandle)
    signal?.removeEventListener("abort", onAbort)
    cleanupTempPromptFile()
    // Flush any trailing line.
    for (const line of splitter.flush()) {
      appendNdjsonLog(line)
      const ev = parseLine(line)
      if (ev === null) {
        parseErrors++
        continue
      }
      handleEvent(ev)
    }
    const stderrTail = stderrChunks.join("").slice(-1000)
    const stderrSuffix = stderrTail ? ` stderr tail:\n${stderrTail}` : ""
    if (killReason === "timeout") {
      exitErr = new Error(
        `cline timed out after ${options.timeoutMs}ms (signal ${sigterm ?? "SIGTERM"}).${stderrSuffix}`,
      )
    } else if (killReason === "abort") {
      exitErr = new Error(`cline aborted by caller (signal ${sigterm ?? "SIGTERM"}).${stderrSuffix}`)
    } else if (code !== 0 && code !== null) {
      exitErr = new Error(
        `cline exited with code ${code}${sigterm ? ` (signal ${sigterm})` : ""}.${stderrSuffix}`,
      )
    } else if (code === null && sigterm) {
      // Killed by signal but neither our timeout nor our abort fired — external SIGTERM/SIGKILL.
      exitErr = new Error(`cline terminated by signal ${sigterm}.${stderrSuffix}`)
    } else {
      // Persisted file is the source of truth (cline writes the final
      // tokens there after stdout closes). Use it whenever it's available;
      // fall back to the streaming-captured snapshot otherwise. We
      // previously used `Math.max(streaming, persisted)`, but that mixed
      // values from different snapshots and produced fluctuating numbers
      // when persisted and streaming disagreed.
      const persistedUsage = taskId === null ? null : readPersistedTaskUsage(taskId, options)
      if (persistedUsage !== null && hasTokenUsage(persistedUsage)) usage = persistedUsage
      // Last-resort output estimate. When cline's provider never reports
      // output tokens (sr-proxy etc.) but we DID see input from the
      // context-window banner, opencode's TUI still wants a non-zero
      // output count for the context panel to advance. Estimate from
      // total assistant chars at ~3 chars/token (Korean/English mix).
      // Only fills in when output is zero AND we have streamed output.
      if (usage.outputTokens === 0 && assistantCharCount > 0 && usage.inputTokens > 0) {
        const estimated = Math.max(1, Math.round(assistantCharCount / 3))
        usage = finalizeUsage({ ...usage, outputTokens: estimated })
      }
      enqueue({ type: "finish", usage, parseErrors })
    }
    done = true
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  })

  // Yield events as they arrive.
  while (true) {
    if (queue.length > 0) {
      const ev = queue.shift()!
      yield ev
      continue
    }
    if (done) {
      if (exitErr !== null) yield { type: "error", error: exitErr }
      return
    }
    await new Promise<void>((resolve) => {
      resolveNext = resolve
    })
  }
}

function wrapErr(err: unknown, prefix: string): Error {
  if (err instanceof Error) {
    const e = new Error(`${prefix}: ${err.message}`)
    e.cause = err
    return e
  }
  return new Error(`${prefix}: ${String(err)}`)
}

/**
 * Cline embeds a human-readable "Context Window Usage" banner inside the
 * environment_details block that ships in every api_req_started prompt:
 *
 *   # Context Window Usage
 *   16,112 / 256K tokens used (6%)
 *
 * Custom cline providers (observed: `sr-proxy`/`GaussO5-CLI`) DO NOT populate
 * the structured `tokensIn/tokensOut/cacheReads/cost` fields in the event's
 * text JSON — they only update this banner. cline's own TUI shows tokens
 * because it reads this banner; opencode-anycli has to do the same to
 * keep parity.
 *
 * The banner reports cumulative INPUT context for THIS turn (history +
 * system + user). We treat it as inputTokens; output tokens stay unknown
 * (best-effort: better than reporting 0/0).
 */
function pickContextWindowUsage(text: string | null): ClineUsage | null {
  if (text === null || text.length === 0) return null
  // cline writes the api_req_started.text field as a JSON-stringified
  // request blob, so the embedded environment_details newlines arrive
  // as the literal two characters `\n` (backslash + n) — NOT real
  // newline characters. We accept both forms so the regex works whether
  // we are inspecting the raw event text or a post-JSON.parse string.
  const match = text.match(
    /# Context Window Usage(?:\s|\\n|\\r)+([\d,]+)\s*\/\s*[\d.,KMkm]+\s*tokens used/,
  )
  if (!match) return null
  const inputTokens = parseInt((match[1] ?? "").replace(/,/g, ""), 10)
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return null
  return finalizeUsage({
    inputTokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: undefined,
  })
}

function pickRunResultUsage(ev: ClineEvent): ClineUsage {
  const usage = (ev as { usage?: unknown }).usage
  const aggregate = (ev as { aggregateUsage?: unknown }).aggregateUsage
  const primary = normalizeAgentUsage(usage)
  if (hasTokenUsage(primary)) return primary
  return normalizeAgentUsage(aggregate)
}

/**
 * Convert cline's current-schema usage payload (with inputTokens /
 * outputTokens / cacheReadTokens / cacheWriteTokens / cost|totalCost,
 * and optional cumulative total* variants) into our internal ClineUsage.
 *
 * Prefer the cumulative `total*` fields when present (interim
 * agent_event.usage snapshots include them); fall back to the per-snapshot
 * fields used by `agent_event.done.usage` and `run_result.usage`.
 */
function normalizeAgentUsage(raw: unknown): ClineUsage {
  if (!isRecord(raw)) return emptyUsage()
  const inputTokens =
    pickNumber(raw, ["totalInputTokens"]) ?? pickNumber(raw, ["inputTokens"]) ?? 0
  const outputTokens =
    pickNumber(raw, ["totalOutputTokens"]) ?? pickNumber(raw, ["outputTokens"]) ?? 0
  const cacheReadTokens =
    pickNumber(raw, ["totalCacheReadTokens"]) ?? pickNumber(raw, ["cacheReadTokens"]) ?? 0
  const cacheWriteTokens =
    pickNumber(raw, ["totalCacheWriteTokens"]) ?? pickNumber(raw, ["cacheWriteTokens"]) ?? 0
  const totalCost = pickNumber(raw, ["totalCost", "cost"])
  return finalizeUsage({
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    totalTokens: 0,
    totalCost,
  })
}

/**
 * Cline's two schemas timestamp events differently — legacy fires Unix-ms
 * numbers, current fires ISO-8601 strings. We need a comparable number to
 * decide whether an interim usage snapshot should win over the previous one.
 */
function pickTsNumber(ev: ClineEvent): number | null {
  const ts = (ev as { ts?: unknown }).ts
  if (typeof ts === "number" && Number.isFinite(ts)) return ts
  if (typeof ts === "string" && ts.length > 0) {
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function pickStringField(ev: ClineEvent, key: string): string | null {
  const value = (ev as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function emptyUsage(): ClineUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: undefined,
  }
}

function finalizeUsage(usage: ClineUsage): ClineUsage {
  return {
    ...usage,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens,
  }
}

function hasTokenUsage(usage: ClineUsage): boolean {
  return usage.totalTokens > 0
}

function pickUsage(ev: ClineEvent): ClineUsage {
  const textUsage = pickTextUsage(ev)
  return finalizeUsage({
    inputTokens: pickNumber(ev, ["tokensIn", "inputTokens"]) ?? textUsage.inputTokens,
    outputTokens: pickNumber(ev, ["tokensOut", "outputTokens"]) ?? textUsage.outputTokens,
    cacheWriteTokens: pickNumber(ev, ["cacheWrites", "cacheWriteTokens"]) ?? textUsage.cacheWriteTokens,
    cacheReadTokens: pickNumber(ev, ["cacheReads", "cacheReadTokens"]) ?? textUsage.cacheReadTokens,
    totalTokens: 0,
    totalCost: pickNumber(ev, ["cost", "totalCost"]) ?? textUsage.totalCost,
  })
}

function pickTextUsage(ev: ClineEvent): ClineUsage {
  const text = pickText(ev)
  if (text === null) return emptyUsage()
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return emptyUsage()
    const usage = isRecord(parsed["usage"]) ? parsed["usage"] : parsed
    return finalizeUsage({
      inputTokens: pickNumber(usage, ["tokensIn", "inputTokens", "promptTokens", "prompt_tokens"]) ?? 0,
      outputTokens: pickNumber(usage, ["tokensOut", "outputTokens", "completionTokens", "completion_tokens"]) ?? 0,
      cacheWriteTokens: pickNumber(usage, ["cacheWrites", "cacheWriteTokens", "cache_creation_input_tokens"]) ?? 0,
      cacheReadTokens: pickNumber(usage, ["cacheReads", "cacheReadTokens", "cache_read_input_tokens"]) ?? 0,
      totalTokens: 0,
      totalCost: pickNumber(usage, ["cost", "totalCost", "total_cost"]),
    })
  } catch {
    return emptyUsage()
  }
}

function pickNumber(source: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(source)) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function pickTaskId(ev: ClineEvent): string | null {
  const taskId = (ev as { taskId?: unknown }).taskId
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null
}

function readPersistedTaskUsage(taskId: string, options: RunInput["options"]): ClineUsage | null {
  const dataDir = clineDataDir(options)
  const taskDir = join(dataDir, "tasks", taskId)

  // Primary source: ui_messages.json. Each api_req_started entry is a
  // snapshot of the cline conversation's tokens AFTER the corresponding
  // API call — they are NOT independent calls to be summed (summing
  // double-counts when cline emits both api_req_started and api_req_finished
  // for the same call, or partial-then-final). Pick the entry with the
  // largest ts that carries token info.
  const uiMessagesPath = join(taskDir, "ui_messages.json")
  if (existsSync(uiMessagesPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(uiMessagesPath, "utf8"))
      if (Array.isArray(raw)) {
        // Only consider entries that describe the CURRENT conversation's
        // last API call. Excluded:
        //   - subagent_usage: tokens from a nested agent's separate context.
        //   - deleted_api_reqs: tokens that were compacted out, NOT current.
        // Including either of those used to surface huge numbers (e.g. one
        // user reported 170K / 133% for "hi" — turned out subagent_usage
        // had the latest ts and was being picked over the real api_req
        // entry).
        let best: { ts: number; usage: ClineUsage } | null = null
        for (const item of raw) {
          if (!isRecord(item) || item["type"] !== "say") continue
          const say = item["say"]
          if (say !== "api_req_started" && say !== "api_req_finished") continue
          const u = pickUsage(item as ClineEvent)
          if (!hasTokenUsage(u)) continue
          const ts = typeof item["ts"] === "number" ? (item["ts"] as number) : 0
          if (best === null || ts >= best.ts) best = { ts, usage: u }
        }
        if (best !== null) return best.usage
      }
    } catch (err) {
      if (DEBUG) process.stderr.write(`[cline-runner] failed to read ui_messages for task ${taskId}: ${String(err)}\n`)
    }
  }

  // Fallback: api_conversation_history.json. Cline writes per-assistant
  // metrics there (`metrics.tokens.{prompt,completion,cached}`, `metrics.cost`)
  // even when the api_req_started entry in ui_messages.json lacks usage —
  // observed for several non-Anthropic provider paths. Same "take the
  // latest" rule applies: each assistant message's metrics reflect the
  // tokens for THAT API call, and we want the final state.
  const apiHistoryPath = join(taskDir, "api_conversation_history.json")
  if (existsSync(apiHistoryPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(apiHistoryPath, "utf8"))
      if (Array.isArray(raw)) {
        let best: { ts: number; usage: ClineUsage } | null = null
        for (const item of raw) {
          if (!isRecord(item) || item["role"] !== "assistant") continue
          const metrics = item["metrics"]
          if (!isRecord(metrics)) continue
          const tokens = isRecord(metrics["tokens"]) ? metrics["tokens"] : null
          if (!tokens) continue
          const promptTokens = pickNumber(tokens, ["prompt"]) ?? 0
          const completionTokens = pickNumber(tokens, ["completion"]) ?? 0
          const cachedTokens = pickNumber(tokens, ["cached"]) ?? 0
          const cost = pickNumber(metrics, ["cost"])
          const u = finalizeUsage({
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            cacheWriteTokens: 0,
            cacheReadTokens: cachedTokens,
            totalTokens: 0,
            totalCost: cost,
          })
          if (!hasTokenUsage(u)) continue
          const ts = typeof item["ts"] === "number" ? (item["ts"] as number) : 0
          if (best === null || ts >= best.ts) best = { ts, usage: u }
        }
        if (best !== null) return best.usage
      }
    } catch (err) {
      if (DEBUG)
        process.stderr.write(
          `[cline-runner] failed to read api_conversation_history for task ${taskId}: ${String(err)}\n`,
        )
    }
  }

  return null
}

function clineDataDir(options: RunInput["options"]): string {
  const args = options.extraArgs ?? []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === "--config" && typeof next === "string") return join(next, "data")
    if (arg?.startsWith("--config=")) return join(arg.slice("--config=".length), "data")
  }
  const home = options.env?.["HOME"] ?? process.env["HOME"] ?? homedir()
  return join(home, ".cline", "data")
}

interface ReadFileCall {
  filePath: string
  offset?: number
  limit?: number
}

function pickReadFileCall(ev: ClineEvent): ReadFileCall | null {
  const say = eventKind(ev, "say")
  if (say !== "tool") return null
  const text = pickText(ev)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (pickString(parsed, "tool") !== "readFile") return null
  // cline emits both a workspace-relative `path` and a resolved absolute
  // `content`. Prefer the absolute form so opencode's tool-part renderer
  // shows an unambiguous path; fall back to the relative one.
  const filePath = pickString(parsed, "content") ?? pickString(parsed, "path")
  if (!filePath) return null
  const start = pickNumber(parsed, ["readLineStart"])
  const end = pickNumber(parsed, ["readLineEnd"])
  const result: ReadFileCall = { filePath }
  if (start !== undefined) result.offset = start
  if (start !== undefined && end !== undefined && end >= start) result.limit = end - start + 1
  return result
}

function pickVisibleText(ev: ClineEvent): VisibleText | null {
  const say = eventKind(ev, "say")
  if (say === "reasoning") {
    const text = pickTextOrReasoning(ev)
    return text === null ? null : { channel: "reasoning", text }
  }
  if (say !== null && VISIBLE_SAY_TEXT_KINDS.has(say)) {
    const text = pickText(ev)
    return text === null ? null : { channel: visibleSayChannel(say), text: normalizeSayText(say, text) }
  }

  const ask = eventKind(ev, "ask")
  if (ask !== null && VISIBLE_ASK_TEXT_KINDS.has(ask)) {
    const text = pickText(ev)
    return text === null ? null : { channel: visibleAskChannel(ask), text: normalizeAskText(ask, text) }
  }

  return null
}

function visibleSayChannel(kind: string): string {
  return kind === "text" || kind === "completion_result" ? "assistant" : `say:${kind}`
}

function visibleAskChannel(kind: string): string {
  return kind === "completion_result" ? "assistant" : `ask:${kind}`
}

function eventKind(ev: ClineEvent, field: "say" | "ask"): string | null {
  const value = (ev as { say?: unknown; ask?: unknown })[field]
  return ev.type === field && typeof value === "string" ? value : null
}

function pickTextOrReasoning(ev: ClineEvent): string | null {
  const text = pickText(ev)
  if (text !== null) return text
  const reasoning = (ev as { reasoning?: unknown }).reasoning
  return typeof reasoning === "string" && reasoning.length > 0 ? reasoning : null
}

function normalizeSayText(kind: string, text: string): string {
  if (kind === "tool") return formatToolText(text)
  return text
}

function formatToolText(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!isRecord(parsed)) return text

  const tool = pickString(parsed, "tool") ?? "tool"
  const path = pickString(parsed, "path")
  const content = pickString(parsed, "content")
  const header = path === null ? `[cline:${tool}]` : `[cline:${tool}] ${path}${formatLineRange(parsed)}`

  if (tool === "readFile") return `${header}\n`
  if (content === null || content.length === 0) return `${header}\n`
  return `${header}\n${content}${content.endsWith("\n") ? "" : "\n"}`
}

function pickString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function formatLineRange(source: Record<string, unknown>): string {
  const start = pickNumber(source, ["readLineStart"])
  const end = pickNumber(source, ["readLineEnd"])
  if (start === undefined) return ""
  if (end === undefined || end === start) return `:${start}`
  return `:${start}-${end}`
}

function normalizeAskText(kind: string, text: string): string {
  if (kind !== "followup" && kind !== "plan_mode_respond") return text

  try {
    const parsed = JSON.parse(text) as { question?: unknown; response?: unknown }
    if (kind === "followup" && typeof parsed.question === "string") return parsed.question
    if (kind === "plan_mode_respond" && typeof parsed.response === "string") return parsed.response
  } catch {
    // Not all cline ask payloads are JSON; fall through to the original text.
  }

  return text
}
