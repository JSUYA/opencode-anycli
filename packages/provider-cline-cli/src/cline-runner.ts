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
import {
  createNdjsonSplitter,
  parseLine,
  isApiReqFinished,
  isApiReqStarted,
  isTaskStarted,
  pickText,
} from "./ndjson-parser.js"
import type { ClineEvent, RunResult } from "./types.js"

const DEBUG = process.env["DEBUG"] === "1"

const VISIBLE_SAY_TEXT_KINDS = new Set([
  "text",
  "completion_result",
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
  | { type: "finish"; usage: RunResult["usage"]; parseErrors: number }
  | { type: "error"; error: Error }

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
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let parseErrors = 0

  for await (const ev of runStreamInternal(input)) {
    if (ev.type === "text-delta") {
      finalText += ev.delta
    } else if (ev.type === "finish") {
      usage = ev.usage
      parseErrors = ev.parseErrors
    } else if (ev.type === "error") {
      throw ev.error
    }
  }

  return { text: finalText, usage, parseErrors }
}

/** Streaming runner — yields incremental text deltas. */
export function runStream(input: RunInput): AsyncIterable<StreamEvent> {
  return runStreamInternal(input)
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function* runStreamInternal(input: RunInput): AsyncGenerator<StreamEvent, void, void> {
  const { prompt, options, signal } = input
  const spawnImpl = input.spawnFn ?? spawn
  const args = buildClineArgs(prompt, options.extraArgs)

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

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnImpl(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: [stdin, "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams
  } catch (err) {
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
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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
      }
      return
    }
    // Edge case: text is a new logical message that doesn't extend the prior one
    // (e.g. cline emits a second say.text after an unrelated event). Treat it as
    // a fresh segment and reset the running prefix to it — never append, which
    // would risk double-emission if the same prefix arrives again.
    enqueue({ type: "text-delta", delta: text })
    emittedByChannel.set(channel, text)
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

  function handleEvent(ev: ClineEvent) {
    if (isTaskStarted(ev) || isApiReqStarted(ev)) {
      // ignore
      return
    }
    if (isApiReqFinished(ev)) {
      const ti = typeof ev.tokensIn === "number" ? ev.tokensIn : 0
      const to = typeof ev.tokensOut === "number" ? ev.tokensOut : 0
      usage = {
        inputTokens: usage.inputTokens + ti,
        outputTokens: usage.outputTokens + to,
        totalTokens: usage.totalTokens + ti + to,
      }
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
    // Flush any trailing line.
    for (const line of splitter.flush()) {
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

function pickVisibleText(ev: ClineEvent): VisibleText | null {
  const say = eventKind(ev, "say")
  if (say === "reasoning") {
    const text = pickTextOrReasoning(ev)
    return text === null ? null : { channel: "reasoning", text }
  }
  if (say !== null && VISIBLE_SAY_TEXT_KINDS.has(say)) {
    const text = pickText(ev)
    return text === null ? null : { channel: visibleSayChannel(say), text }
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
