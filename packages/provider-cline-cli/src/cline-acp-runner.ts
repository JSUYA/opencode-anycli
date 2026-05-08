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
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import type * as schema from "@agentclientprotocol/sdk"
import type { ClineUsage, RunResult } from "./types.js"
import type { RunInput, StreamEvent } from "./cline-runner.js"
import { CLINE_READ_TOOL_NAME } from "./cline-runner.js"

const DEBUG = process.env["DEBUG"] === "1"

export async function runOnceAcp(input: RunInput): Promise<RunResult> {
  let finalText = ""
  let usage = emptyUsage()
  let parseErrors = 0
  for await (const ev of runStreamAcp(input)) {
    if (ev.type === "text-delta") finalText += ev.delta
    else if (ev.type === "tool-call") finalText += renderToolCallMarker(ev) ?? ""
    else if (ev.type === "finish") {
      usage = ev.usage
      parseErrors = ev.parseErrors
    } else if (ev.type === "error") {
      throw ev.error
    }
  }
  return { text: finalText, usage, parseErrors }
}

export function runStreamAcp(input: RunInput): AsyncIterable<StreamEvent> {
  return runStreamAcpInternal(input)
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function* runStreamAcpInternal(input: RunInput): AsyncGenerator<StreamEvent, void, void> {
  const { options, signal } = input

  const args = ["--acp", ...(options.extraArgs ?? [])]
  const env = { ...process.env, ...(options.env ?? {}) }

  // stderr inherited so cline's diagnostics still surface; stdin/stdout are
  // the JSON-RPC transport.
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    }) as unknown as ChildProcessWithoutNullStreams
  } catch (err) {
    yield { type: "error", error: wrapErr(err, `Failed to spawn cline (${options.command} --acp)`) }
    return
  }

  // Track exit cause so we can surface a real error in `close` instead of
  // silently emitting a finish event.
  let killReason: "timeout" | "abort" | "client-error" | null = null

  const timeoutHandle = setTimeout(() => {
    killReason = "timeout"
    if (DEBUG) process.stderr.write(`[cline-acp] timeout after ${options.timeoutMs}ms — killing pid ${child.pid}\n`)
    child.kill("SIGTERM")
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL")
    }, 2000).unref()
  }, options.timeoutMs)
  timeoutHandle.unref()

  const onAbort = () => {
    killReason = "abort"
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
  const inputBytes = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
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
        translateSessionUpdate(update, { enqueue, emittedReads, assistantState })
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
      // Closing stdin lets cline detect EOF and shut down cleanly. If we
      // SIGTERM instead, cline's signal handler emits ANSI escapes +
      // "SIGTERM received…" to stdout, which the SDK's NDJSON parser
      // logs as a parse error. EOF avoids that noise entirely.
      try { child.stdin.end() } catch { /* ignore */ }
    } catch (err) {
      killReason = killReason ?? "client-error"
      exitErr = wrapErr(err, "cline ACP turn failed")
      try { child.kill("SIGTERM") } catch { /* ignore */ }
    }
  })()

  child.on("error", (err) => {
    exitErr = wrapErr(err, "cline subprocess error")
    finish()
  })
  child.on("close", (code, sigterm) => {
    clearTimeout(timeoutHandle)
    signal?.removeEventListener("abort", onAbort)
    if (killReason === "timeout") {
      exitErr = new Error(`cline ACP timed out after ${options.timeoutMs}ms (signal ${sigterm ?? "SIGTERM"})`)
    } else if (killReason === "abort") {
      exitErr = new Error(`cline ACP aborted by caller (signal ${sigterm ?? "SIGTERM"})`)
    } else if (exitErr === null && code !== 0 && code !== null) {
      exitErr = new Error(`cline --acp exited with code ${code}${sigterm ? ` (signal ${sigterm})` : ""}`)
    } else if (exitErr === null && code === null && sigterm) {
      exitErr = new Error(`cline --acp terminated by signal ${sigterm}`)
    } else if (exitErr === null) {
      enqueue({ type: "finish", usage, parseErrors: 0 })
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
function translateSessionUpdate(
  update: schema.SessionUpdate,
  ctx: {
    enqueue: (ev: StreamEvent) => void
    emittedReads: Set<string>
    assistantState: { acc: string }
  },
): void {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk": {
      // Thoughts are independent of the user-visible message stream.
      const text = blockToText(update.content)
      if (text) ctx.enqueue({ type: "text-delta", delta: text })
      return
    }
    case "agent_message_chunk": {
      // cline streams assistant tokens here, then re-emits the full
      // `attempt_completion` result as a single chunk. Dedup: if the
      // incoming chunk is exactly what we've already accumulated, drop it.
      const text = blockToText(update.content)
      if (!text) return
      if (text === ctx.assistantState.acc) {
        // Pure restate of what we already streamed.
        return
      }
      if (ctx.assistantState.acc.length > 0 && text.startsWith(ctx.assistantState.acc)) {
        // Prefix-extending restate: emit only the genuinely new tail.
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
      // ACP tool calls map onto opencode's read tool only when the cline
      // tool was actually a file read — that's the path that triggers
      // LSP.touchFile in opencode. Anything else (bash, edit, search, …)
      // is surfaced inline as cline already streams text describing it via
      // agent_message_chunk, so we don't double-up.
      const filePath = pickReadFilePath(update)
      if (filePath && !ctx.emittedReads.has(filePath)) {
        ctx.emittedReads.add(filePath)
        const toolCallId = `cline-acp-read-${randomUUID()}`
        ctx.enqueue({
          type: "tool-call",
          toolCallId,
          toolName: CLINE_READ_TOOL_NAME,
          input: { filePath },
        })
        ctx.enqueue({
          type: "tool-result",
          toolCallId,
          toolName: CLINE_READ_TOOL_NAME,
          result: { ok: true, filePath },
        })
      }
      return
    }
    default:
      // plan / available_commands_update / current_mode_update /
      // config_option_update / session_info_update — informational. Drop
      // for now; could be surfaced later via providerMetadata if useful.
      return
  }
}

function blockToText(content: schema.ContentBlock | undefined): string {
  if (!content) return ""
  if (content.type === "text" && typeof content.text === "string") return content.text
  return ""
}

// Pull the file path out of a tool_call / tool_call_update if it represents
// a read. cline's ACP populates `kind` with one of ToolKind ("read",
// "edit", "execute", …); locations[].path carries the file. Falls back to
// rawInput.filePath / .path for older cline builds.
function pickReadFilePath(update: schema.ToolCall | schema.ToolCallUpdate): string | null {
  const kind = (update as { kind?: unknown }).kind
  if (kind !== "read" && kind !== undefined) return null
  const locations = (update as { locations?: ReadonlyArray<{ path?: string }> }).locations
  const fromLocation = locations?.find((l) => typeof l.path === "string")?.path
  if (fromLocation) return fromLocation
  const rawInput = (update as { rawInput?: unknown }).rawInput
  if (rawInput && typeof rawInput === "object" && rawInput !== null) {
    const r = rawInput as Record<string, unknown>
    if (typeof r["filePath"] === "string") return r["filePath"] as string
    if (typeof r["path"] === "string") return r["path"] as string
  }
  return null
}

function renderToolCallMarker(ev: { toolName: string; input: Record<string, unknown> }): string | null {
  if (ev.toolName !== CLINE_READ_TOOL_NAME) return null
  const filePath = typeof ev.input["filePath"] === "string" ? (ev.input["filePath"] as string) : null
  if (!filePath) return null
  return `[cline-acp:read] ${filePath}\n`
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
