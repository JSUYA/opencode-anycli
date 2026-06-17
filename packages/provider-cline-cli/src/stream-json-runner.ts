// Generic subprocess driver for CLIs that stream line-delimited JSON.
//
// Used by the claude and codex flavors. Mirrors cline-runner's RunInput /
// StreamEvent contract so the language-model glue consumes all flavors the
// same way. The prompt is written to the child's stdin (then stdin is closed),
// so there is no argv length ceiling. stdout is split into JSON lines and fed
// to a per-flavor parser (see cli-profiles.ts) that yields StreamEvent's.

import { spawn, type ChildProcess } from "node:child_process"
import { createNdjsonSplitter } from "./ndjson-parser.js"
import type { RunInput, StreamEvent } from "./cline-runner.js"
import type { ClineUsage } from "./types.js"
import type { CliRunProfile } from "./cli-profiles.js"

const DEBUG = process.env["DEBUG"] === "1"

export function runStreamJson(input: RunInput, profile: CliRunProfile): AsyncIterable<StreamEvent> {
  return runStreamJsonInternal(input, profile)
}

async function* runStreamJsonInternal(input: RunInput, profile: CliRunProfile): AsyncGenerator<StreamEvent, void, void> {
  const { options, signal } = input
  const spawnImpl = input.spawnFn ?? spawn
  const env = { ...process.env, ...(options.env ?? {}) }

  let child: ChildProcess
  try {
    child = spawnImpl(profile.command, profile.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (err) {
    yield { type: "error", error: wrapErr(err, `Failed to spawn ${profile.label} (${profile.command})`) }
    return
  }

  let killReason: "timeout" | "abort" | null = null

  const timeoutHandle = setTimeout(() => {
    killReason = "timeout"
    if (DEBUG) process.stderr.write(`[${profile.label}] timeout after ${options.timeoutMs}ms — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL")
    }, 2000).unref()
  }, options.timeoutMs)
  timeoutHandle.unref()

  const onAbort = () => {
    killReason = "abort"
    if (DEBUG) process.stderr.write(`[${profile.label}] aborted — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort)
  }

  // Producer/consumer queue.
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
  function finish() {
    done = true
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  }

  // Deliver the prompt on stdin, then EOF so the CLI starts the turn.
  try {
    child.stdin?.write(input.prompt)
    child.stdin?.end()
  } catch {
    /* the child may have died already; close handler reports it */
  }

  let usage: ClineUsage = emptyUsage()
  let contextMax: number | undefined
  let parseErrors = 0
  const splitter = createNdjsonSplitter()
  const stderrChunks: string[] = []

  const handleLine = (line: string) => {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      parseErrors++
      return
    }
    const parsed = profile.parseLine(obj)
    for (const ev of parsed.events) enqueue(ev)
    if (parsed.usage) usage = parsed.usage
    if (parsed.contextMax !== undefined) contextMax = parsed.contextMax
    if (parsed.fatalError !== undefined && exitErr === null) {
      exitErr = new Error(`${profile.label}: ${parsed.fatalError}`)
    }
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    for (const line of splitter.push(chunk.toString())) handleLine(line)
  })
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const s = chunk.toString()
    stderrChunks.push(s)
    if (DEBUG) process.stderr.write(s)
  })

  child.on("error", (err) => {
    exitErr = wrapErr(err, `${profile.label} subprocess error`)
    finish()
  })
  child.on("close", (code, sigterm) => {
    clearTimeout(timeoutHandle)
    signal?.removeEventListener("abort", onAbort)
    for (const line of splitter.flush()) handleLine(line)
    if (killReason === "timeout") {
      exitErr = new Error(`${profile.label} timed out after ${options.timeoutMs}ms (signal ${sigterm ?? "SIGTERM"})`)
    } else if (killReason === "abort") {
      exitErr = new Error(`${profile.label} aborted by caller (signal ${sigterm ?? "SIGTERM"})`)
    } else if (exitErr === null && code !== 0 && code !== null) {
      const tail = stderrChunks.join("").trim().slice(-1000)
      exitErr = new Error(`${profile.command} exited with code ${code}${tail ? `\n${tail}` : ""}`)
    } else if (exitErr === null && code === null && sigterm) {
      exitErr = new Error(`${profile.label} terminated by signal ${sigterm}`)
    } else if (exitErr === null) {
      enqueue({ type: "finish", usage, parseErrors, ...(contextMax !== undefined ? { contextMax } : {}) })
    }
    finish()
  })

  // Yield events as they arrive.
  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!
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

function wrapErr(err: unknown, prefix: string): Error {
  if (err instanceof Error) {
    const e = new Error(`${prefix}: ${err.message}`)
    e.cause = err
    return e
  }
  return new Error(`${prefix}: ${String(err)}`)
}
