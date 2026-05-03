import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { runOnce, runStream } from "../src/cline-runner.js"
import { ClineLanguageModel } from "../src/language-model.js"
import { createCline } from "../src/provider.js"

// ─── Fake subprocess factory ──────────────────────────────────────────────────

interface FakeProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  pid: number
  killed: boolean
  kill: (sig?: NodeJS.Signals | number) => boolean
}

function makeFakeProc(stdoutLines: string[], opts: { exitCode?: number; delayMs?: number } = {}): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 12345
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    return true
  }
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })

  setTimeout(() => {
    for (const line of stdoutLines) {
      proc.stdout.push(line + "\n")
    }
    proc.stdout.push(null)
    proc.stderr.push(null)
    setTimeout(() => proc.emit("close", opts.exitCode ?? 0, null), 5)
  }, opts.delayMs ?? 0)

  return proc
}

function fakeSpawn(stdoutLines: string[], opts?: { exitCode?: number }) {
  return ((_cmd: string, _args?: readonly string[], _options?: object) =>
    makeFakeProc(stdoutLines, opts ?? {}) as unknown as ChildProcessWithoutNullStreams) as unknown as typeof import("node:child_process").spawn
}

/**
 * Capturing fake spawn that records the spawn options it received so we can
 * assert on stdio settings. Returns the fake proc otherwise like fakeSpawn.
 */
function capturingSpawn(stdoutLines: string[]): {
  fn: typeof import("node:child_process").spawn
  capturedOptions: { value: { stdio?: unknown } | null }
} {
  const captured: { value: { stdio?: unknown } | null } = { value: null }
  const fn = ((_cmd: string, _args?: readonly string[], options?: { stdio?: unknown }) => {
    captured.value = options ?? {}
    return makeFakeProc(stdoutLines, {}) as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import("node:child_process").spawn
  return { fn, capturedOptions: captured }
}

/**
 * Fake proc that NEVER closes on its own. Used to test timeout / abort paths —
 * the test relies on the runner's own kill() to trigger close. The fake's kill
 * implementation emits a `close` event with code=null and the signal name.
 */
function makeHangingProc(initialLines: string[] = []): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 99999
  proc.killed = false
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  proc.kill = (sig?: NodeJS.Signals | number) => {
    proc.killed = true
    const sigName = typeof sig === "string" ? sig : "SIGTERM"
    setTimeout(() => {
      proc.stdout.push(null)
      proc.stderr.push(null)
      proc.emit("close", null, sigName)
    }, 1)
    return true
  }
  setTimeout(() => {
    for (const line of initialLines) proc.stdout.push(line + "\n")
  }, 0)
  return proc
}

function hangingSpawn(initialLines: string[] = []) {
  return ((_cmd: string, _args?: readonly string[], _options?: object) =>
    makeHangingProc(initialLines) as unknown as ChildProcessWithoutNullStreams) as unknown as typeof import("node:child_process").spawn
}

// ─── runOnce / runStream tests ────────────────────────────────────────────────

describe("runOnce", () => {
  it("collects final say.text into result.text", async () => {
    const out = [
      '{"type":"task_started","taskId":"t1"}',
      '{"type":"say","say":"text","text":"hello world","partial":false}',
      '{"type":"say","say":"completion_result","text":"hello world"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("hello world")
    expect(result.parseErrors).toBe(0)
  })

  it("streams partials and ends up with the final concatenated text", async () => {
    const out = [
      '{"type":"task_started"}',
      '{"type":"say","say":"text","text":"hel","partial":true}',
      '{"type":"say","say":"text","text":"hello","partial":true}',
      '{"type":"say","say":"text","text":"hello world","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("hello world")
  })

  it("harvests token counts from api_req_finished", async () => {
    const out = [
      '{"type":"task_started"}',
      '{"type":"say","say":"api_req_finished","tokensIn":120,"tokensOut":30}',
      '{"type":"say","say":"text","text":"ok","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
  })

  it("returns zero usage when api_req_finished is absent (does not fabricate)", async () => {
    const out = ['{"type":"say","say":"text","text":"hi","partial":false}']
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it("counts parse errors but keeps going", async () => {
    const out = [
      "garbage line",
      '{"type":"say","say":"text","text":"after garbage","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("after garbage")
    expect(result.parseErrors).toBe(1)
  })

  it("ignores reasoning, api_req_started, task_started events", async () => {
    const out = [
      '{"type":"task_started"}',
      '{"type":"say","say":"reasoning","text":"thinking..."}',
      '{"type":"say","say":"api_req_started","text":"prompt sent"}',
      '{"type":"say","say":"text","text":"final","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("final")
    expect(result.text).not.toContain("thinking")
  })

  it("rejects when cline exits non-zero", async () => {
    const out = ['{"type":"say","say":"text","text":"oops","partial":false}']
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        spawnFn: fakeSpawn(out, { exitCode: 1 }),
      }),
    ).rejects.toThrow(/exited with code 1/)
  })

  it("rejects with explicit timeout error when cline does not finish in time", async () => {
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 50 },
        spawnFn: hangingSpawn(),
      }),
    ).rejects.toThrow(/timed out after 50ms/)
  })

  it("rejects with explicit abort error when caller aborts", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        signal: ac.signal,
        spawnFn: hangingSpawn(),
      }),
    ).rejects.toThrow(/aborted by caller/)
  })

  it("rejects when cline is killed by external signal", async () => {
    // Use a fake proc that immediately closes with code=null and a signal name —
    // emulating something like an OS-level OOM kill.
    const externalKillSpawn = ((_cmd: string, _args?: readonly string[], _options?: object) => {
      const proc = new EventEmitter() as FakeProc
      proc.pid = 1
      proc.killed = false
      proc.stdout = new Readable({ read() {} })
      proc.stderr = new Readable({ read() {} })
      proc.kill = () => true
      setTimeout(() => {
        proc.stdout.push(null)
        proc.stderr.push(null)
        proc.emit("close", null, "SIGKILL")
      }, 5)
      return proc as unknown as ChildProcessWithoutNullStreams
    }) as unknown as typeof import("node:child_process").spawn
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        spawnFn: externalKillSpawn,
      }),
    ).rejects.toThrow(/terminated by signal SIGKILL/)
  })

  it("uses stdio[0]='inherit' for stdin by default (TTY ON)", async () => {
    const out = ['{"type":"say","say":"text","text":"x","partial":false}']
    const cap = capturingSpawn(out)
    delete process.env["OPENCODE_ANYCLI_TTY"]
    await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: cap.fn,
    })
    expect(cap.capturedOptions.value).not.toBeNull()
    const stdio = (cap.capturedOptions.value as { stdio?: unknown[] }).stdio
    expect(stdio?.[0]).toBe("inherit")
  })

  it("uses stdio[0]='ignore' when OPENCODE_ANYCLI_TTY=0 (opt-out)", async () => {
    const out = ['{"type":"say","say":"text","text":"x","partial":false}']
    const cap = capturingSpawn(out)
    process.env["OPENCODE_ANYCLI_TTY"] = "0"
    try {
      await runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        spawnFn: cap.fn,
      })
      const stdio = (cap.capturedOptions.value as { stdio?: unknown[] }).stdio
      expect(stdio?.[0]).toBe("ignore")
    } finally {
      delete process.env["OPENCODE_ANYCLI_TTY"]
    }
  })

  it("does not double-emit when an unrelated text segment follows a final say", async () => {
    // Edge case the safer emitTextIfNew else-branch handles: cline emits
    // one final text "abc", then later emits an unrelated text "xyz". The
    // result should contain both segments concatenated, NOT abc twice.
    const out = [
      '{"type":"say","say":"text","text":"abc","partial":false}',
      '{"type":"say","say":"text","text":"xyz","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("abcxyz")
  })
})

describe("runStream", () => {
  it("yields text-delta events and a final finish", async () => {
    const out = [
      '{"type":"say","say":"text","text":"a","partial":true}',
      '{"type":"say","say":"text","text":"ab","partial":true}',
      '{"type":"say","say":"text","text":"abc","partial":false}',
    ]
    const events: string[] = []
    let finished = false
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "text-delta") events.push(ev.delta)
      if (ev.type === "finish") finished = true
    }
    expect(events.join("")).toBe("abc")
    expect(finished).toBe(true)
  })
})

// ─── ClineLanguageModel tests ────────────────────────────────────────────────

describe("ClineLanguageModel", () => {
  it("exposes the v3 shape", () => {
    const model = new ClineLanguageModel("default", { command: "cline" })
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("cline")
    expect(model.modelId).toBe("default")
    expect(model.supportedUrls).toEqual({})
  })

  it("doGenerate throws in passthrough mode", async () => {
    const passthrough = new ClineLanguageModel("default", { mode: "passthrough" })
    // Cast: the LanguageModelV3CallOptions type is structural; we only need
    // a `prompt` field to reach the mode check.
    const fakeOpts = { prompt: [{ role: "user", content: "hi" }] } as unknown as Parameters<typeof passthrough.doGenerate>[0]
    await expect(passthrough.doGenerate(fakeOpts)).rejects.toThrow(/Passthrough mode not yet implemented/)
  })

  it("doStream throws in passthrough mode (consumed via for-await)", async () => {
    const passthrough = new ClineLanguageModel("default", { mode: "passthrough" })
    const fakeOpts = { prompt: [{ role: "user", content: "hi" }] } as unknown as Parameters<typeof passthrough.doStream>[0]
    await expect(passthrough.doStream(fakeOpts)).rejects.toThrow(/Passthrough mode not yet implemented/)
  })
})

describe("createCline factory", () => {
  it("returns a callable provider that creates LanguageModelV3 instances", () => {
    const provider = createCline({ command: "cline" })
    const model = provider.languageModel("default")
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("cline")
    expect(model.modelId).toBe("default")
    // Convenience callable form.
    const m2 = provider("custom-model")
    expect(m2.modelId).toBe("custom-model")
  })

  it("textEmbeddingModel and imageModel throw 'not supported'", () => {
    const provider = createCline()
    expect(() => provider.textEmbeddingModel("any")).toThrow(/does not support text embeddings/)
    expect(() => provider.imageModel("any")).toThrow(/does not support image generation/)
  })
})
