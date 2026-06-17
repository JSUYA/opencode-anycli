import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { runStreamJson } from "../src/stream-json-runner.js"
import { resolveCliRunProfile } from "../src/cli-profiles.js"
import type { StreamEvent } from "../src/cline-runner.js"

interface FakeProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: Writable
  pid: number
  killed: boolean
  kill: (sig?: NodeJS.Signals | number) => boolean
}

function makeFakeProc(stdoutLines: string[], opts: { exitCode?: number } = {}): { proc: FakeProc; stdinData: string[] } {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 4242
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    return true
  }
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  const stdinData: string[] = []
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinData.push(chunk.toString())
      cb()
    },
  })

  setTimeout(() => {
    for (const line of stdoutLines) proc.stdout.push(line + "\n")
    proc.stdout.push(null)
    proc.stderr.push(null)
    setTimeout(() => proc.emit("close", opts.exitCode ?? 0, null), 5)
  }, 0)

  return { proc, stdinData }
}

function fakeSpawn(stdoutLines: string[], opts: { exitCode?: number } = {}, sink?: { stdin?: string[] }) {
  return ((_cmd: string, _args?: readonly string[], _options?: object) => {
    const { proc, stdinData } = makeFakeProc(stdoutLines, opts)
    if (sink) sink.stdin = stdinData
    return proc as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import("node:child_process").spawn
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("runStreamJson — claude", () => {
  const profile = resolveCliRunProfile("claude", "opus-4.8-high", "claude")
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
    '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"h"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"i"}}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"hi","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":1},"modelUsage":{"claude-opus-4-8":{"contextWindow":1000000}}}',
  ]

  it("streams text deltas and a final finish with result usage", async () => {
    const sink: { stdin?: string[] } = {}
    const events = await collect(
      runStreamJson(
        { prompt: "FLATTENED PROMPT", options: { command: "claude", timeoutMs: 5000 }, spawnFn: fakeSpawn(lines, {}, sink) },
        profile,
      ),
    )
    const deltas = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta)
    expect(deltas.join("")).toBe("hi")

    const finish = events.find((e) => e.type === "finish")
    expect(finish).toBeDefined()
    const fin = finish as Extract<StreamEvent, { type: "finish" }>
    expect(fin.usage.inputTokens).toBe(10)
    expect(fin.usage.outputTokens).toBe(4)
    expect(fin.usage.totalCost).toBe(0.01)
    expect(fin.contextMax).toBe(1000000)
    expect(fin.parseErrors).toBe(0)

    // prompt delivered via stdin, not argv
    expect(sink.stdin?.join("")).toBe("FLATTENED PROMPT")
  })
})

describe("runStreamJson — codex", () => {
  const profile = resolveCliRunProfile("codex", "gpt-5.5-high", "codex")
  const lines = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5,"reasoning_output_tokens":0}}',
  ]

  it("streams the agent_message and a finish with turn usage", async () => {
    const events = await collect(
      runStreamJson(
        { prompt: "P", options: { command: "codex", timeoutMs: 5000 }, spawnFn: fakeSpawn(lines) },
        profile,
      ),
    )
    const deltas = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta)
    expect(deltas.join("")).toBe("hi")
    const fin = events.find((e) => e.type === "finish") as Extract<StreamEvent, { type: "finish" }>
    expect(fin.usage.inputTokens).toBe(100)
    expect(fin.usage.outputTokens).toBe(5)
    expect(fin.usage.cacheReadTokens).toBe(10)
  })

  it("emits an error event on turn.failed", async () => {
    const events = await collect(
      runStreamJson(
        {
          prompt: "P",
          options: { command: "codex", timeoutMs: 5000 },
          spawnFn: fakeSpawn(['{"type":"turn.failed","error":{"message":"boom"}}']),
        },
        profile,
      ),
    )
    const err = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>
    expect(err).toBeDefined()
    expect(err.error.message).toContain("boom")
    expect(events.some((e) => e.type === "finish")).toBe(false)
  })
})

describe("runStreamJson — process failure", () => {
  const profile = resolveCliRunProfile("claude", "opus-4.8-high", "claude")

  it("surfaces a non-zero exit as an error", async () => {
    const events = await collect(
      runStreamJson(
        { prompt: "P", options: { command: "claude", timeoutMs: 5000 }, spawnFn: fakeSpawn([], { exitCode: 2 }) },
        profile,
      ),
    )
    const err = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>
    expect(err).toBeDefined()
    expect(err.error.message).toContain("exited with code 2")
  })

  it("counts unparseable lines as parseErrors without crashing", async () => {
    const events = await collect(
      runStreamJson(
        {
          prompt: "P",
          options: { command: "claude", timeoutMs: 5000 },
          spawnFn: fakeSpawn(["not json", '{"type":"result","usage":{"input_tokens":1,"output_tokens":1}}']),
        },
        profile,
      ),
    )
    const fin = events.find((e) => e.type === "finish") as Extract<StreamEvent, { type: "finish" }>
    expect(fin.parseErrors).toBe(1)
    expect(fin.usage.inputTokens).toBe(1)
  })
})
