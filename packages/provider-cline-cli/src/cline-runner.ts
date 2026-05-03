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
  isSayText,
  isSayCompletion,
  isSayReasoning,
  isApiReqFinished,
  isApiReqStarted,
  isTaskStarted,
  isPartial,
  pickText,
} from "./ndjson-parser.js"
import type { ClineEvent, RunResult } from "./types.js"

const DEBUG = process.env["DEBUG"] === "1"

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

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnImpl(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
  let totalEmitted = ""
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let parseErrors = 0

  function emitTextIfNew(text: string) {
    if (text.length === 0) return
    // Common case: this text extends what we've already streamed (cline partial → final).
    if (text.startsWith(totalEmitted)) {
      const delta = text.slice(totalEmitted.length)
      if (delta.length > 0) {
        enqueue({ type: "text-delta", delta })
        totalEmitted = text
      }
      return
    }
    // Edge case: text is a new logical message that doesn't extend the prior one
    // (e.g. cline emits a second say.text after an unrelated event). Treat it as
    // a fresh segment and reset the running prefix to it — never append, which
    // would risk double-emission if the same prefix arrives again.
    enqueue({ type: "text-delta", delta: text })
    totalEmitted = text
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
    if (isTaskStarted(ev) || isApiReqStarted(ev) || isSayReasoning(ev)) {
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
    if (isSayText(ev)) {
      emitTextIfNew(pickText(ev) ?? "")
      return
    }
    if (isSayCompletion(ev)) {
      emitTextIfNew(pickText(ev) ?? "")
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
