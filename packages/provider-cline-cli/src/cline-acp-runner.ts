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
import { readdirSync, readFileSync, statSync } from "node:fs"
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

/**
 * Parse /proc/<pid>/stat → { ppid, state, cpu (utime+stime jiffies) }, or null
 * if the process is gone (or /proc is unavailable). The comm field (2) may
 * contain spaces/parens, so we split after its closing paren.
 */
export function readProcStat(pid: number): { ppid: number; state: string; cpu: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const rp = stat.lastIndexOf(")")
    if (rp < 0) return null
    const f = stat.slice(rp + 2).trim().split(/\s+/) // f[0]=state(3) f[1]=ppid(4) f[11]=utime(14) f[12]=stime(15)
    return { state: f[0] ?? "?", ppid: Number(f[1]) || 0, cpu: (Number(f[11]) || 0) + (Number(f[12]) || 0) }
  } catch {
    return null
  }
}

/**
 * rchar+wchar from /proc/<pid>/io: the cumulative bytes this task has passed to
 * read()/write()-family syscalls. This counts sockets, pipes, tty and files —
 * NOT just physical disk I/O — so it advances whenever cline is doing real work
 * that burns little or no CPU: waiting on / streaming tokens from a remote model
 * over a socket, or (the case that bit us) reading and atomically rewriting its
 * multi-MB `~/.cline-sr` task-history file on every turn. Returns 0 if
 * unreadable (kernel too old, or /proc/<pid>/io gone because the process died).
 */
export function readProcIo(pid: number): number {
  try {
    const io = readFileSync(`/proc/${pid}/io`, "utf8")
    const rchar = Number(/rchar:\s*(\d+)/.exec(io)?.[1] ?? 0)
    const wchar = Number(/wchar:\s*(\d+)/.exec(io)?.[1] ?? 0)
    return (Number.isFinite(rchar) ? rchar : 0) + (Number.isFinite(wchar) ? wchar : 0)
  } catch {
    return 0
  }
}

/**
 * Liveness + a monotonic PROGRESS metric over the process subtree rooted at
 * `root`: CPU jiffies (utime+stime) AND I/O bytes (rchar+wchar). Either one
 * advancing between two samples means cline is doing real work and is NOT
 * deadlocked.
 *
 * CPU alone is NOT enough. The common case — cline waiting on or streaming from
 * a REMOTE model, where inference runs on the server and the local process just
 * blocks on a socket — burns ~zero CPU, and so does the several-second window in
 * which cline reads+rewrites its big task-history file (I/O-bound). A CPU-only
 * probe misreads both as a deadlock and SIGKILLs a perfectly healthy turn (which
 * also aborts the atomic history write, leaving `.tmp` orphans that slow the
 * NEXT turn — a compounding failure). Folding in I/O bytes fixes this: a working
 * cline moves megabytes even at idle CPU; only a genuinely wedged process (lock
 * contention, futex) moves neither.
 *
 * `alive:false` → root process is gone; `cpu:NaN` → /proc unreadable (can't
 * probe, caller should keep waiting). Summing the whole subtree means a cline
 * blocked on a long child command (itself burning CPU or doing I/O) still shows
 * progress.
 */
export function subtreeProgress(root: number): { alive: boolean; zombie: boolean; cpu: number; io: number } {
  let names: string[]
  try {
    names = readdirSync("/proc")
  } catch {
    return { alive: true, zombie: false, cpu: NaN, io: 0 }
  }
  const info = new Map<number, { ppid: number; state: string; cpu: number }>()
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const rec = readProcStat(Number(n))
    if (rec) info.set(Number(n), rec)
  }
  const rootRec = info.get(root)
  if (!rootRec) return { alive: false, zombie: false, cpu: 0, io: 0 }
  let cpu = 0
  let io = 0
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const p = stack.pop()!
    if (seen.has(p)) continue
    seen.add(p)
    const rec = info.get(p)
    if (rec) cpu += rec.cpu
    io += readProcIo(p)
    for (const [pid, r] of info) if (r.ppid === p) stack.push(pid)
  }
  return { alive: true, zombie: rootRec.state === "Z", cpu, io }
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

  // Headless auto-approval. `cline --acp` is otherwise INTERACTIVE: it blocks
  // mid-turn on asks that have no ACP responder. Tool approvals do come through
  // `session/request_permission` (which our client auto-allows), but cline's
  // FRAMEWORK asks — `mistake_limit_reached` ("Cline is having trouble, continue
  // with guidance?") and `resume_task` — are not bridged; cline holds the turn
  // open waiting for an answer that never arrives, so it sits at zero CPU/IO
  // until the watchdog kills it and opencode retries (the endless "Thinking"
  // loop we observed). --yolo + --auto-approve-all run cline fully
  // non-interactively so those asks auto-proceed instead of hanging. This
  // auto-approves ALL actions (including shell commands) without prompting —
  // matching subprocess mode, which already runs `--yolo`. Escape hatch: set
  // OPENCODE_ANYCLI_ACP_NO_YOLO=1 to drop them (turns may then hang on an ask).
  const autoApprove = process.env["OPENCODE_ANYCLI_ACP_NO_YOLO"] === "1" ? [] : ["--yolo", "--auto-approve-all"]
  const args = ["--acp", ...autoApprove, ...(options.extraArgs ?? [])]
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
  let killReason: "abort" | "client-error" | "idle-timeout" | "idle-graceful" | null = null

  // Diagnostic breadcrumbs: which ACP phase the turn is in and whether cline has
  // streamed anything yet. Folded into the stall error so a hang tells us WHERE
  // it hung — initialize / newSession / awaiting the model's first token /
  // mid-stream — instead of just "stalled". A stall in newSession points at
  // ~/.cline-sr state; a stall while awaiting-first-token points at model
  // latency (a huge prompt's prefill); a mid-stream stall points at a blocked
  // tool/command.
  let phase: "spawn" | "initialize" | "newSession" | "awaiting-first-token" | "streaming" = "spawn"
  let sawOutput = false

  // Health watchdog. ACP has no TOTAL time limit (large prompts / long
  // inference must run to completion), but a stalled or deadlocked cline —
  // e.g. several subagents contending on the shared ~/.cline-sr state — streams
  // NOTHING and would otherwise hang forever: the turn never ends, so
  // opencode's `task` tool never resolves and the orchestrator waits on the
  // subagent indefinitely.
  //
  // We do NOT kill on elapsed time alone. A silent period only TRIGGERS a
  // health check: we sample the cline process tree's CPU *and* I/O over a short
  // window (see subtreeProgress) and terminate only when the state is
  // unrecoverable — the process is gone, defunct (zombie), or advanced NEITHER
  // CPU nor I/O (deadlocked). A cline that is genuinely working keeps advancing
  // and is left alone: local inference / a busy child burns CPU, while a remote
  // model wait or the multi-MB task-history read+rewrite moves I/O bytes at ~0
  // CPU. (Sampling CPU only, as the first cut did, false-killed those I/O-bound
  // turns — the bug this fixes.)
  //
  // Default silence window is 300s. A slow cold first turn (big prompt, cold
  // page cache, a bloated ~/.cline-sr task-history file, or a queued remote
  // model) can legitimately produce no ACP event for over a minute; the old 90s
  // default cut those off. A real deadlock hangs indefinitely (25+ min observed)
  // so 300s still recovers it well before that. Override with the env var.
  const idleMs = (() => {
    const raw = Number(process.env["OPENCODE_ANYCLI_ACP_IDLE_MS"])
    return Number.isFinite(raw) && raw > 0 ? raw : 300_000
  })()
  const probeMs = 3_000
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  function clearIdle() {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null }
  }
  const terminateHung = (reason: string) => {
    if (done) return
    clearIdle()
    forwardDiag = false
    if (DEBUG) process.stderr.write(`[cline-acp] ${reason} [phase=${phase}, output=${sawOutput ? "streamed" : "none"}] — killing pid ${child.pid}\n`)

    if (sawOutput) {
      // cline streamed a response and then went silent. This is almost never a
      // true deadlock — it's cline holding the turn OPEN on an interactive ask
      // that ACP can't answer: `mistake_limit_reached` ("Cline is having
      // trouble, continue with guidance?"), `resume_task`, or a followup
      // question. --yolo auto-approves *actions* but cannot answer a question,
      // so cline waits forever. Erroring here makes opencode retry the same
      // message endlessly (the "Thinking" loop). Instead FINISH the turn
      // gracefully with what cline already streamed: opencode surfaces cline's
      // message (its question / "I'm stuck" note) as a normal reply, the retry
      // loop stops, and the user can respond in the next turn.
      killReason = "idle-graceful"
      try { child.kill("SIGKILL") } catch { /* ignore */ }
      const taskId = latestClineTaskId(options, runStartMs)
      const recovered = taskId !== null ? readPersistedTaskUsage(taskId, options) : null
      enqueue({ type: "finish", usage: recovered ?? usage, parseErrors: 0 })
      finish()
      return
    }

    // No output at all — a genuine early hang (initialize / newSession / a
    // prefill that never produced a first token). Nothing to salvage; surface an
    // error so the caller (and any parent task) isn't blocked forever.
    killReason = "idle-timeout"
    exitErr = new Error(
      `cline --acp ${reason} [phase=${phase}, output=none]; ` +
        `aborting the turn so the caller (and any parent task) isn't blocked forever. ` +
        `Tune the silence window with OPENCODE_ANYCLI_ACP_IDLE_MS.`,
    )
    try { child.kill("SIGKILL") } catch { /* ignore */ }
    enqueue({ type: "error", error: exitErr })
    finish()
  }
  function armIdle() {
    if (done) return
    const pid = child.pid
    if (pid === undefined) return // no pid to watch
    clearIdle()
    idleTimer = setTimeout(() => {
      if (done) return
      const before = subtreeProgress(pid)
      if (!before.alive) return terminateHung("process exited without a terminal event")
      if (before.zombie) return terminateHung("process is defunct (zombie)")
      if (Number.isNaN(before.cpu)) return armIdle() // can't probe (no /proc) — keep waiting
      // Silent for idleMs. Sample again after a short window: terminate only if
      // the tree is gone/defunct or advanced NEITHER CPU nor I/O (deadlocked).
      probeTimer = setTimeout(() => {
        if (done) return
        const after = subtreeProgress(pid)
        if (!after.alive) return terminateHung("process exited without a terminal event")
        if (Number.isNaN(after.cpu)) return armIdle() // probe failed this round — keep waiting
        if (after.zombie) return terminateHung("process is defunct (zombie)")
        if (after.cpu <= before.cpu && after.io <= before.io) {
          return terminateHung(`stalled with no output for ${Math.round(idleMs / 1000)}s and no CPU or I/O progress (deadlocked)`)
        }
        armIdle() // still making progress — leave it running
      }, probeMs)
      if (typeof probeTimer.unref === "function") probeTimer.unref()
    }, idleMs)
    if (typeof idleTimer.unref === "function") idleTimer.unref()
  }

  const onAbort = () => {
    killReason = "abort"
    clearIdle()
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
    if (ev.type === "text-delta" || ev.type === "reasoning-delta" || ev.type === "tool-call" || ev.type === "tool-result") {
      sawOutput = true
      phase = "streaming"
    }
    armIdle() // any real ACP activity resets the silence window
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  }
  function finish() {
    done = true
    clearIdle()
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

  // Arm the health watchdog now: cline could stall during initialize/newSession
  // (before any event), and enqueue() re-arms it on every subsequent event.
  armIdle()

  // Run the prompt turn. ACP delivers session updates via `clientImpl.sessionUpdate`
  // as the agent works; the `prompt(...)` call resolves with a `stopReason`
  // when the turn completes (or rejects on protocol/transport error).
  ;(async () => {
    try {
      phase = "initialize"
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // We don't advertise fs / terminal — cline self-services those.
        },
      })
      phase = "newSession"
      const sess = await connection.newSession({
        cwd: options.cwd ?? process.cwd(),
        mcpServers: [],
      })
      // Prompt sent; nothing streamed back yet. If we stall here it's the model
      // taking too long to produce its first token (a huge prompt's prefill),
      // not cline being wedged — enqueue() flips this to "streaming" on the
      // first chunk.
      phase = "awaiting-first-token"
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
    if (killReason === "idle-graceful") {
      // Graceful stall-finish already enqueued a `finish` event; our own SIGKILL
      // is expected cleanup, so do NOT turn it into an error.
    } else if (killReason === "abort") {
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
