// Cline subprocess driver — ACP (Agent Client Protocol) variant.
//
// Spawns `cline --acp` and speaks the Agent Client Protocol over stdio
// JSON-RPC, instead of cline's `--json --yolo --act <prompt>` argv path.
//
// Why this exists: cline's `--act <prompt>` argument carries the entire
// flattened conversation in argv, which the kernel limits via ARG_MAX
// (~2 MiB on Linux, 256 KiB–1 MiB on macOS). Long sessions or large
// pasted file context eventually trip E2BIG at spawn time. ACP routes
// the prompt through stdio JSON-RPC instead, so the only ceiling is
// available memory — long inputs become a non-issue.
//
// Public API mirrors cline-runner's `runStream` / `runOnce` so the
// language-model glue can route by `options.mode` without caring which
// transport is in use.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Readable, Writable, Transform } from "node:stream"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import type * as schema from "@agentclientprotocol/sdk"
import type { ClineUsage, RunResult } from "./types.js"
import type { RunInput, StreamEvent } from "./cline-runner.js"
import { clineDataDir, readPersistedTaskUsage } from "./cline-runner.js"
import { bridgeAcpTool, buildAcpToolResult } from "./cline-tool-bridge.js"

const DEBUG = process.env["DEBUG"] === "1"

/**
 * A Transform that forwards only lines that look like JSON-RPC objects (trimmed
 * line starts with `{`) and drops everything else. cline's stdout is the ACP
 * transport, so during normal operation every line is a JSON object; the only
 * non-JSON output is shutdown noise (an ANSI "SIGTERM received…" banner) which
 * would otherwise make the SDK's ndJsonStream throw an uncaught JSON parse
 * error and dump a stack trace to the user's terminal.
 */
function jsonLinesOnly(): Transform {
  let buf = ""
  const keep = (line: string): boolean => line.replace(/\[[0-9;?]*[A-Za-z]/g, "").trim().startsWith("{")
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8")
      let nl: number
      let out = ""
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (keep(line)) out += line + "\n"
      }
      cb(null, out.length > 0 ? Buffer.from(out, "utf8") : undefined)
    },
    flush(cb) {
      cb(null, keep(buf) ? Buffer.from(buf, "utf8") : undefined)
    },
  })
}

export async function runOnceAcp(input: RunInput): Promise<RunResult> {
  let finalText = ""
  let usage = emptyUsage()
  let parseErrors = 0
  for await (const ev of runStreamAcp(input)) {
    if (ev.type === "text-delta") finalText += ev.delta
    else if (ev.type === "finish") {
      usage = ev.usage
      parseErrors = ev.parseErrors
    } else if (ev.type === "error") {
      throw ev.error
    }
    // reasoning-delta / tool-call / tool-result are not part of the answer text:
    // reasoning is cline's thinking, tool events are provider-executed. The
    // doGenerate caller only parses <opencode-call> tags out of `finalText`.
  }
  return { text: finalText, usage, parseErrors }
}

export function runStreamAcp(input: RunInput): AsyncIterable<StreamEvent> {
  return runStreamAcpInternal(input)
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function* runStreamAcpInternal(input: RunInput): AsyncGenerator<StreamEvent, void, void> {
  const { options, signal } = input

  // Marker for usage recovery: cline (as of 0.5.1) does not report token usage
  // over ACP, so on a clean finish we recover it from the newest cline task
  // dir touched during THIS run. -1000ms guards against clock skew.
  const runStartMs = Date.now() - 1000

  const args = ["--acp", ...(options.extraArgs ?? [])]
  const env = { ...process.env, ...(options.env ?? {}) }

  // stdin/stdout are the JSON-RPC transport. stderr is PIPED (not inherited)
  // and forwarded to our stderr only while the turn is live. On teardown
  // (normal finish / abort / error) cline writes shutdown noise — a "SIGTERM
  // received" banner and, when the host is exiting mid-turn, EPIPE crash-dumps
  // as its transport pipe breaks. Piping lets us stop forwarding so that noise
  // never reaches the user's terminal; and if the host process dies outright,
  // the pipe's read end closes with it, so an orphaned cline's stderr writes
  // fail silently instead of flooding the terminal.
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams
  } catch (err) {
    yield { type: "error", error: wrapErr(err, `Failed to spawn cline (${options.command} --acp)`) }
    return
  }

  // True while the turn is live; flipped off the instant we start tearing down
  // so cline's shutdown chatter is dropped rather than printed.
  let forwardDiag = true
  child.stderr.on("data", (chunk: Buffer) => {
    if (forwardDiag) process.stderr.write(chunk)
  })
  // Once cline exits or the host tears down, our writes (stdin) or cline's
  // reads/writes can EPIPE; an unhandled 'error' on these pipes would crash the
  // host instead of ending quietly. Swallow them.
  child.stdin.on("error", () => {})
  child.stdout.on("error", () => {})
  child.stderr.on("error", () => {})

  // Track exit cause so we can surface a real error in `close` instead of
  // silently emitting a finish event.
  // Timeout disabled — ACP mode runs without time limit for large prompt support.
  let killReason: "abort" | "client-error" | null = null

  const onAbort = () => {
    killReason = "abort"
    // Stop forwarding cline's stderr: aborting mid-turn is exactly when it
    // emits the SIGTERM banner + EPIPE crash-dumps we want to hide.
    forwardDiag = false
    if (DEBUG) process.stderr.write(`[cline-acp] aborted — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
  }
  signal?.addEventListener("abort", onAbort)

  // Event queue + producer/consumer plumbing.
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

  // Stream conversion: Node child stdio ↔ Web streams the SDK expects.
  // cline's stdout is the JSON-RPC transport — every line SHOULD be a JSON
  // object. But on shutdown cline's SIGTERM handler prints an ANSI banner
  // ("SIGTERM received, shutting down…") to that same stream. The SDK's
  // ndJsonStream JSON.parses every line and throws (uncaught → terminal stack
  // dump at sdk/dist/stream.js) on that banner. Interpose a line filter that
  // drops anything that isn't a JSON object before the SDK sees it.
  const filteredStdout = child.stdout.pipe(jsonLinesOnly())
  filteredStdout.on("error", () => {})
  const inputBytes = Readable.toWeb(filteredStdout) as ReadableStream<Uint8Array>
  const outputBytes = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const stream = ndJsonStream(outputBytes, inputBytes)

  // Track read tool calls we've already surfaced — cline's ACP emits
  // `tool_call` then one or more `tool_call_update` for the same toolCallId.
  // We mirror cline-runner's behaviour (one `tool-call` per filePath) so
  // opencode's session timeline doesn't fill with duplicates.
  const emittedReads = new Set<string>()
  // cline (as of 2.18) emits the assistant message twice over ACP: first
  // token-by-token via `agent_message_chunk`, then once more in a single
  // chunk carrying the full `attempt_completion` result. Without dedup
  // the user-visible text reads "FOO" + "FOO". We track the running
  // assistant accumulator and drop any chunk that is an exact duplicate
  // of (or strict prefix-restate of) what we've already streamed.
  const assistantState = { acc: "" }
  // ACP tool_call carries `kind`+`rawInput`; the matching tool_call_update(s)
  // carry `status`/`rawOutput` (often WITHOUT kind). Stash the resolved
  // opencode tool name + kind by toolCallId so the terminal update can emit
  // the tool-result even when its own payload omits the kind.
  const pendingTools = new Map<string, { toolName: string; kind: string | undefined }>()
  let usage: ClineUsage = emptyUsage()

  // Build the Client implementation ACP delivers callbacks to.
  const clientImpl: Client = {
    requestPermission: async (params) => {
      // Yolo mode: pick the first "allow"-class option, falling back to the
      // first option of any kind. ACP defines kinds as
      // "allow_always" | "allow_once" | "reject_always" | "reject_once".
      const opts = params.options ?? []
      const allow = opts.find((o) => o.kind === "allow_always") ?? opts.find((o) => o.kind === "allow_once") ?? opts[0]
      if (!allow) {
        return { outcome: { outcome: "cancelled" } }
      }
      return { outcome: { outcome: "selected", optionId: allow.optionId } }
    },
    sessionUpdate: async ({ update }) => {
      try {
        translateSessionUpdate(update, { enqueue, emittedReads, assistantState, pendingTools })
      } catch (err) {
        if (DEBUG) process.stderr.write(`[cline-acp] sessionUpdate error: ${String(err)}\n`)
      }
    },
    // We deliberately omit fs.readTextFile / fs.writeTextFile and the
    // terminal/* methods. cline's ACP server runs those internally when
    // the client doesn't advertise the capability — same as `--json --yolo`
    // in subprocess mode handles them inside cline. opencode's separate
    // `read` tool call (which we mirror via `tool-call` emission) covers
    // the LSP-touch side.
  }

  const connection = new ClientSideConnection(() => clientImpl, stream)

  // Run the prompt turn. ACP delivers session updates via `clientImpl.sessionUpdate`
  // as the agent works; the `prompt(...)` call resolves with a `stopReason`
  // when the turn completes (or rejects on protocol/transport error).
  ;(async () => {
    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // We don't advertise fs / terminal — cline self-services those.
        },
      })
      const sess = await connection.newSession({
        cwd: options.cwd ?? process.cwd(),
        mcpServers: [],
      })
      const result = await connection.prompt({
        sessionId: sess.sessionId,
        prompt: [{ type: "text", text: input.prompt }],
      })
      // PromptResponse may carry usage metadata via _meta — cline doesn't
      // populate it as of 2.18, so usage from streaming + persisted files
      // (handled by the caller / language-model layer) remains the source
      // of truth.
      void result
      // Turn complete — stop forwarding cline's stderr before it shuts down so
      // its EOF/SIGTERM banner and any EPIPE chatter aren't printed.
      forwardDiag = false
      // Closing stdin lets cline detect EOF and shut down cleanly. If we
      // SIGTERM instead, cline's signal handler emits ANSI escapes +
      // "SIGTERM received…" to stdout, which the SDK's NDJSON parser
      // logs as a parse error. EOF avoids that noise entirely.
      try { child.stdin.end() } catch { /* ignore */ }
    } catch (err) {
      forwardDiag = false
      killReason = killReason ?? "client-error"
      exitErr = wrapErr(err, "cline ACP turn failed")
      try { child.kill("SIGTERM") } catch { /* ignore */ }
    }
  })()

  child.on("error", (err) => {
    forwardDiag = false
    exitErr = wrapErr(err, "cline subprocess error")
    finish()
  })
  child.on("close", (code, sigterm) => {
    forwardDiag = false
    signal?.removeEventListener("abort", onAbort)
    if (killReason === "abort") {
      exitErr = new Error(`cline ACP aborted by caller (signal ${sigterm ?? "SIGTERM"})`)
    } else if (exitErr === null && code !== 0 && code !== null) {
      exitErr = new Error(`cline --acp exited with code ${code}${sigterm ? ` (signal ${sigterm})` : ""}`)
    } else if (exitErr === null && code === null && sigterm) {
      exitErr = new Error(`cline --acp terminated by signal ${sigterm}`)
    } else if (exitErr === null) {
      const taskId = latestClineTaskId(options, runStartMs)
      const recovered = taskId !== null ? readPersistedTaskUsage(taskId, options) : null
      enqueue({ type: "finish", usage: recovered ?? usage, parseErrors: 0 })
    }
    finish()
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

// Translate one ACP SessionUpdate into 0..N StreamEvent's.
// Exported for unit testing (see cline-acp-runner-bridge.test.ts).
export function translateSessionUpdate(
  update: schema.SessionUpdate,
  ctx: {
    enqueue: (ev: StreamEvent) => void
    emittedReads: Set<string>
    assistantState: { acc: string }
    pendingTools: Map<string, { toolName: string; kind: string | undefined }>
  },
): void {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk": {
      // cline reasoning — route to a reasoning stream part, NOT the answer
      // text (otherwise the thinking pollutes the visible message).
      const text = blockToText(update.content)
      if (text) ctx.enqueue({ type: "reasoning-delta", delta: text })
      return
    }
    case "agent_message_chunk": {
      // cline streams assistant tokens here, then re-emits the full
      // `attempt_completion` result as a single chunk. Dedup: if the
      // incoming chunk is exactly what we've already accumulated, drop it.
      const text = blockToText(update.content)
      if (!text) return
      if (text === ctx.assistantState.acc) return
      if (ctx.assistantState.acc.length > 0 && text.startsWith(ctx.assistantState.acc)) {
        const tail = text.slice(ctx.assistantState.acc.length)
        ctx.assistantState.acc = text
        ctx.enqueue({ type: "text-delta", delta: tail })
        return
      }
      ctx.assistantState.acc += text
      ctx.enqueue({ type: "text-delta", delta: text })
      return
    }
    case "user_message_chunk":
      // Echoes our own prompt back. Discard.
      return
    case "tool_call":
    case "tool_call_update": {
      const u = update as unknown as {
        toolCallId?: unknown
        kind?: unknown
        status?: unknown
        rawInput?: unknown
        rawOutput?: unknown
        content?: unknown
        title?: unknown
      }
      const id = typeof u.toolCallId === "string" ? u.toolCallId : null
      if (id === null) return
      const kind = typeof u.kind === "string" ? u.kind : undefined

      // Emit the tool-call once, when we first learn the kind + input.
      if (!ctx.pendingTools.has(id) && kind !== undefined) {
        const bridged = bridgeAcpTool(kind, u.rawInput)
        if (bridged === null) {
          // Unmapped kind (fetch/think/…): opencode drops unknown tool names,
          // so surface a text marker rather than a dangling call.
          const title = typeof u.title === "string" ? u.title : kind
          ctx.enqueue({ type: "text-delta", delta: `[cline:${kind}] ${title}\n` })
          ctx.pendingTools.set(id, { toolName: "", kind })
        } else {
          // De-dupe reads by filePath (cline re-reads the same file).
          if (bridged.toolName === "read") {
            const fp = typeof bridged.input["filePath"] === "string" ? (bridged.input["filePath"] as string) : null
            if (fp !== null) {
              if (ctx.emittedReads.has(fp)) {
                ctx.pendingTools.set(id, { toolName: "", kind })
                return
              }
              ctx.emittedReads.add(fp)
            }
          }
          ctx.pendingTools.set(id, { toolName: bridged.toolName, kind })
          ctx.enqueue({
            type: "tool-call",
            toolCallId: `cline-acp-${id}`,
            toolName: bridged.toolName,
            input: bridged.input,
          })
        }
      }

      // Emit the tool-result on a terminal status.
      const status = typeof u.status === "string" ? u.status : null
      if (status === "completed" || status === "failed") {
        const pend = ctx.pendingTools.get(id)
        if (pend && pend.toolName.length > 0) {
          const contentText = pickAcpContentText(u.content)
          const result = buildAcpToolResult(pend.toolName, u.rawOutput, contentText, status === "completed")
          ctx.enqueue({
            type: "tool-result",
            toolCallId: `cline-acp-${id}`,
            toolName: pend.toolName,
            result,
            ...(status === "failed" ? { isError: true } : {}),
          })
          ctx.pendingTools.delete(id)
        }
      }
      return
    }
    default:
      // plan / available_commands_update / current_mode_update /
      // config_option_update / session_info_update — informational. Drop.
      return
  }
}

function blockToText(content: schema.ContentBlock | undefined): string {
  if (!content) return ""
  if (content.type === "text" && typeof content.text === "string") return content.text
  return ""
}

// Best-effort text extraction from an ACP ToolCallContent[] ("content" variant
// wraps a ContentBlock; "diff"/"terminal" carry no plain text). rawOutput is
// the primary result source; this is only a fallback.
function pickAcpContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const item of content) {
    if (item && typeof item === "object") {
      const inner = (item as { content?: unknown }).content
      if (inner && typeof inner === "object" && (inner as { type?: unknown }).type === "text") {
        const t = (inner as { text?: unknown }).text
        if (typeof t === "string" && t.length > 0) return t
      }
      const direct = (item as { text?: unknown }).text
      if (typeof direct === "string" && direct.length > 0) return direct
    }
  }
  return null
}

/**
 * Find the cline task id whose dir was (re)written during this ACP run. cline
 * writes each turn's state to <dataDir>/tasks/<id>/; an ACP prompt maps to one
 * task, so the newest dir touched at/after `sinceMs` is this session's. Parallel
 * cline lanes use isolated --config dirs (OPENCODE_ANYCLI_CLINE_CONFIG), so they
 * don't collide within a single dataDir. Returns null if none / on error.
 */
function latestClineTaskId(options: RunInput["options"], sinceMs: number): string | null {
  const tasksDir = join(clineDataDir(options), "tasks")
  let best: { id: string; mtime: number } | null = null
  let entries: string[]
  try {
    entries = readdirSync(tasksDir)
  } catch {
    return null
  }
  for (const id of entries) {
    try {
      const st = statSync(join(tasksDir, id))
      if (!st.isDirectory()) continue
      const mtime = st.mtimeMs
      if (mtime >= sinceMs && (best === null || mtime > best.mtime)) best = { id, mtime }
    } catch {
      /* ignore unreadable entry */
    }
  }
  return best?.id ?? null
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
