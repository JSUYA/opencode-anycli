import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: undefined,
  }
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
    expect(result.usage).toEqual({ ...zeroUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 })
  })

  it("harvests token counts from api_req_finished text JSON", async () => {
    const out = [
      '{"type":"task_started"}',
      '{"type":"say","say":"api_req_finished","text":"{\\"tokensIn\\":120,\\"tokensOut\\":30,\\"cacheWrites\\":10,\\"cacheReads\\":5,\\"cost\\":0.25}"}',
      '{"type":"say","say":"text","text":"ok","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheWriteTokens: 10,
      cacheReadTokens: 5,
      totalTokens: 165,
      totalCost: 0.25,
    })
  })

  it("harvests latest tokens from cline api_req_started updates (does not sum)", async () => {
    // Two snapshots in stream order — the latest one wins. cline emits the
    // same call's usage multiple times (e.g. partial/final or
    // started/finished pair), and summing inflates the count by 2× / 3×.
    const out = [
      '{"type":"say","say":"api_req_started","ts":1,"text":"{\\"request\\":\\"prompt\\",\\"tokensIn\\":100,\\"tokensOut\\":20,\\"cacheReads\\":40}"}',
      '{"type":"say","say":"api_req_started","ts":2,"text":"{\\"request\\":\\"prompt\\",\\"tokensIn\\":110,\\"tokensOut\\":30,\\"cacheReads\\":50}"}',
      '{"type":"say","say":"text","text":"ok","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage).toEqual({
      ...zeroUsage(),
      inputTokens: 110,
      outputTokens: 30,
      cacheReadTokens: 50,
      totalTokens: 190,
    })
  })

  it("does NOT sum api_req_started + api_req_finished snapshots for the same call", async () => {
    // Repro for the "single-word prompt at 25%" inflation: cline configs
    // that emit BOTH events with the same numbers used to double-count.
    const out = [
      '{"type":"say","say":"api_req_started","ts":1,"text":"{\\"tokensIn\\":7976,\\"tokensOut\\":538,\\"cacheReads\\":6144}"}',
      '{"type":"say","say":"api_req_finished","ts":2,"text":"{\\"tokensIn\\":7976,\\"tokensOut\\":538,\\"cacheReads\\":6144}"}',
      '{"type":"say","say":"text","text":"ok","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(7976)
    expect(result.usage.outputTokens).toBe(538)
    expect(result.usage.cacheReadTokens).toBe(6144)
  })

  it("falls back to persisted cline task usage when stdout omits usage updates", async () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-anycli-test-"))
    try {
      const taskDir = join(home, ".cline", "data", "tasks", "task-1")
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, "ui_messages.json"),
        JSON.stringify([
          {
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ request: "prompt", tokensIn: 100, tokensOut: 20, cacheWrites: 10, cacheReads: 5 }),
          },
        ]),
      )
      const out = [
        '{"type":"task_started","taskId":"task-1"}',
        '{"type":"say","say":"api_req_started","ts":1,"text":"{\\"request\\":\\"prompt\\"}"}',
        '{"type":"say","say":"text","text":"ok","partial":false}',
      ]
      const result = await runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000, env: { HOME: home } },
        spawnFn: fakeSpawn(out),
      })
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cacheWriteTokens: 10,
        cacheReadTokens: 5,
        totalTokens: 135,
        totalCost: undefined,
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("uses the latest persisted api_req_started entry, not a sum", async () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-anycli-test-"))
    try {
      const taskDir = join(home, ".cline", "data", "tasks", "task-3")
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, "ui_messages.json"),
        JSON.stringify([
          { type: "say", say: "api_req_started", ts: 100, text: JSON.stringify({ tokensIn: 50, tokensOut: 10 }) },
          { type: "say", say: "api_req_started", ts: 200, text: JSON.stringify({ tokensIn: 80, tokensOut: 25, cacheReads: 30 }) },
        ]),
      )
      const out = [
        '{"type":"task_started","taskId":"task-3"}',
        '{"type":"say","say":"text","text":"ok","partial":false}',
      ]
      const result = await runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000, env: { HOME: home } },
        spawnFn: fakeSpawn(out),
      })
      expect(result.usage.inputTokens).toBe(80)
      expect(result.usage.outputTokens).toBe(25)
      expect(result.usage.cacheReadTokens).toBe(30)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("falls back to api_conversation_history metrics when ui_messages lacks usage", async () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-anycli-test-"))
    try {
      const taskDir = join(home, ".cline", "data", "tasks", "task-2")
      mkdirSync(taskDir, { recursive: true })
      // ui_messages.json present but with no token fields in the JSON text
      // — emulates the observed behaviour for several non-Anthropic providers.
      writeFileSync(
        join(taskDir, "ui_messages.json"),
        JSON.stringify([
          {
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ request: "prompt" }),
          },
        ]),
      )
      writeFileSync(
        join(taskDir, "api_conversation_history.json"),
        JSON.stringify([
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            ts: 100,
            content: [{ type: "text", text: "hello" }],
            metrics: { tokens: { prompt: 200, completion: 40, cached: 80 }, cost: 0.012 },
          },
          {
            role: "assistant",
            ts: 200,
            content: [{ type: "text", text: "follow-up" }],
            metrics: { tokens: { prompt: 250, completion: 50, cached: 100 }, cost: 0.015 },
          },
        ]),
      )
      const out = [
        '{"type":"task_started","taskId":"task-2"}',
        '{"type":"say","say":"text","text":"ok","partial":false}',
      ]
      const result = await runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000, env: { HOME: home } },
        spawnFn: fakeSpawn(out),
      })
      // Latest assistant entry (ts=200) wins; we do NOT sum across calls.
      expect(result.usage).toEqual({
        inputTokens: 250,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 100,
        totalTokens: 400,
        totalCost: 0.015,
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("harvests usage from cline's current-schema run_result event", async () => {
    // Cline 2.18 emits a new terminal `run_result` event whose `usage`
    // object carries the final cumulative tokens. Older code only looked
    // at legacy `say.api_req_*` events and missed every token.
    const out = [
      '{"ts":"2026-05-13T08:44:50.988Z","type":"hook_event","hookEventName":"agent_start","taskId":"conv_x"}',
      '{"ts":"2026-05-13T08:44:50.989Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
      '{"ts":"2026-05-13T08:44:55.330Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":"2 + 2 = 4"}}',
      '{"ts":"2026-05-13T08:44:55.548Z","type":"agent_event","event":{"type":"usage","inputTokens":2843,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":0,"cost":0,"totalInputTokens":2843,"totalOutputTokens":11,"totalCacheReadTokens":0,"totalCacheWriteTokens":0,"totalCost":0}}',
      '{"ts":"2026-05-13T08:44:55.549Z","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"2 + 2 = 4"}}',
      '{"ts":"2026-05-13T08:44:55.552Z","type":"agent_event","event":{"type":"done","reason":"completed","text":"2 + 2 = 4","iterations":1,"usage":{"inputTokens":2843,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0}}}',
      '{"ts":"2026-05-13T08:44:55.593Z","type":"run_result","finishReason":"completed","iterations":1,"usage":{"inputTokens":2843,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"aggregateUsage":{"inputTokens":2843,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"durationMs":4566,"text":"2 + 2 = 4"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("2 + 2 = 4")
    expect(result.usage).toEqual({
      inputTokens: 2843,
      outputTokens: 11,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 2854,
      totalCost: 0,
    })
  })

  it("falls back to run_result aggregateUsage when primary usage is empty", async () => {
    // Defensive: if cline ever ships a build where `usage` is omitted but
    // `aggregateUsage` is populated, we should still capture the totals.
    const out = [
      '{"ts":"2026-05-13T08:44:55.593Z","type":"run_result","finishReason":"completed","usage":{},"aggregateUsage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":20,"cacheWriteTokens":0,"totalCost":0.01},"text":"hi"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(50)
    expect(result.usage.cacheReadTokens).toBe(20)
    expect(result.usage.totalCost).toBe(0.01)
  })

  it("prefers terminal run_result usage over a later interim usage event", async () => {
    // Defensive: an out-of-order interim agent_event.usage MUST NOT clobber
    // the authoritative terminal usage. Without this guard, a late
    // diagnostic snapshot in some cline builds would zero the totals.
    const out = [
      '{"ts":"2026-05-13T08:44:55.593Z","type":"run_result","finishReason":"completed","usage":{"inputTokens":2843,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0.05},"text":"ok"}',
      '{"ts":"2026-05-13T08:44:55.999Z","type":"agent_event","event":{"type":"usage","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalInputTokens":0,"totalOutputTokens":0,"totalCacheReadTokens":0,"totalCacheWriteTokens":0,"totalCost":0}}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(2843)
    expect(result.usage.outputTokens).toBe(11)
    expect(result.usage.totalCost).toBe(0.05)
  })

  it("captures the agent_event.content_start text deltas as the final answer", async () => {
    const out = [
      '{"ts":"2026-05-13T08:44:55.300Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
      '{"ts":"2026-05-13T08:44:55.330Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":"Hello"}}',
      '{"ts":"2026-05-13T08:44:55.331Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":", world"}}',
      '{"ts":"2026-05-13T08:44:55.332Z","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"Hello, world"}}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("Hello, world")
  })

  it("rejects when cline emits a top-level error event before exit", async () => {
    const out = [
      '{"ts":"2026-05-13T08:44:25.268Z","type":"error","message":"Our servers are currently overloaded. Please try again later."}',
    ]
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        spawnFn: fakeSpawn(out),
      }),
    ).rejects.toThrow(/overloaded/)
  })

  it("rejects when agent_event surfaces an error sub-event", async () => {
    const out = [
      '{"ts":"2026-05-13T08:44:25.268Z","type":"agent_event","event":{"type":"error","error":{"name":"Error","message":"upstream timeout"},"recoverable":false,"iteration":1}}',
    ]
    await expect(
      runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000 },
        spawnFn: fakeSpawn(out),
      }),
    ).rejects.toThrow(/upstream timeout/)
  })

  it("uses hook_event taskId for persisted-file fallback (current schema)", async () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-anycli-test-"))
    try {
      const taskDir = join(home, ".cline", "data", "tasks", "task-hook")
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, "ui_messages.json"),
        JSON.stringify([
          {
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ tokensIn: 77, tokensOut: 9 }),
          },
        ]),
      )
      const out = [
        '{"ts":"2026-05-13T08:44:50.988Z","type":"hook_event","hookEventName":"agent_start","taskId":"task-hook"}',
        '{"ts":"2026-05-13T08:44:50.989Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
        '{"ts":"2026-05-13T08:44:55.330Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":"ok"}}',
      ]
      const result = await runOnce({
        prompt: "ignored",
        options: { command: "cline", timeoutMs: 5000, env: { HOME: home } },
        spawnFn: fakeSpawn(out),
      })
      expect(result.usage.inputTokens).toBe(77)
      expect(result.usage.outputTokens).toBe(9)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("extracts cumulative input tokens from cline's # Context Window Usage banner", async () => {
    // Repro for sr-proxy/GaussO5-CLI: cline emits api_req_started with the
    // text JSON containing ONLY `request` (no tokensIn/tokensOut) — the
    // only token signal available is the human-readable banner cline
    // embeds inside environment_details. We must recover input tokens
    // from there so opencode's "Context: X tokens Y%" stops reading 0.
    const embeddedPrompt = JSON.stringify({
      request:
        "<task>\nhi\n</task>\n\n<environment_details>\n# Context Window Usage\n16,374 / 256K tokens used (6%)\n\n# Current Mode\nACT MODE\n</environment_details>\n\nLoading...",
    })
    const out = [
      '{"type":"task_started","taskId":"t-srproxy"}',
      `{"ts":1,"type":"say","say":"api_req_started","text":${JSON.stringify(embeddedPrompt)}}`,
      '{"type":"say","say":"completion_result","text":"ok"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(16374)
    // outputTokens may be a small positive estimate derived from streamed
    // text length (sr-proxy never reports it). Total = input + estimate.
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(16374)
    expect(result.usage.totalTokens).toBeLessThan(16400)
  })

  it("uses the latest # Context Window Usage banner across multi-iteration runs", async () => {
    const turn1 = JSON.stringify({
      request: "<task>...</task><environment_details># Context Window Usage\n100 / 256K tokens used (0%)</environment_details>",
    })
    const turn2 = JSON.stringify({
      request: "<task>...</task><environment_details># Context Window Usage\n18,810 / 256K tokens used (7%)</environment_details>",
    })
    const out = [
      '{"type":"task_started","taskId":"t"}',
      `{"ts":1,"type":"say","say":"api_req_started","text":${JSON.stringify(turn1)}}`,
      `{"ts":2,"type":"say","say":"api_req_started","text":${JSON.stringify(turn2)}}`,
      '{"type":"say","say":"completion_result","text":"ok"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(18810)
  })

  it("prefers structured tokensIn from api_req_started text over the banner", async () => {
    // When both are present (openai-codex path), the structured numbers win.
    const text = JSON.stringify({
      request:
        "<task>...</task># Context Window Usage\n9999 / 256K tokens used (3%)\n",
      tokensIn: 1234,
      tokensOut: 56,
    })
    const out = [
      '{"type":"task_started","taskId":"t"}',
      `{"ts":1,"type":"say","say":"api_req_started","text":${JSON.stringify(text)}}`,
      '{"type":"say","say":"completion_result","text":"ok"}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage.inputTokens).toBe(1234)
    expect(result.usage.outputTokens).toBe(56)
  })

  it("returns zero usage when api_req_finished is absent (does not fabricate)", async () => {
    const out = ['{"type":"say","say":"text","text":"hi","partial":false}']
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.usage).toEqual(zeroUsage())
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

  it("surfaces reasoning while still ignoring internal api/task events", async () => {
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
    expect(result.text).toBe("thinking...final")
    expect(result.text).not.toContain("prompt sent")
  })

  it("surfaces visible cline output text events", async () => {
    const out = [
      '{"type":"say","say":"command_output","text":"line 1\\nline 2\\n","partial":false}',
      '{"type":"say","say":"info","text":"done","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("line 1\nline 2\ndone")
  })

  it("renders cline readFile activity as a textual marker (runOnce path)", async () => {
    const out = [
      '{"type":"say","say":"tool","text":"{\\"tool\\":\\"readFile\\",\\"path\\":\\"docs/configuration.md\\",\\"content\\":\\"/repo/docs/configuration.md\\",\\"readLineStart\\":1,\\"readLineEnd\\":32}","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("[cline:readFile] /repo/docs/configuration.md:1-32\n")
  })

  it("emits a structured read tool-call/result pair on stream", async () => {
    const out = [
      '{"type":"say","say":"tool","text":"{\\"tool\\":\\"readFile\\",\\"path\\":\\"docs/configuration.md\\",\\"content\\":\\"/repo/docs/configuration.md\\",\\"readLineStart\\":1,\\"readLineEnd\\":32}","partial":false}',
    ]
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = []
    const results: Array<{ toolName: string; result: Record<string, unknown> }> = []
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "tool-call") calls.push({ toolName: ev.toolName, input: ev.input })
      else if (ev.type === "tool-result") results.push({ toolName: ev.toolName, result: ev.result })
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe("read")
    expect(calls[0]!.input).toEqual({ filePath: "/repo/docs/configuration.md", offset: 1, limit: 32 })
    expect(results).toHaveLength(1)
    expect(results[0]!.toolName).toBe("read")
    expect(results[0]!.result).toMatchObject({ ok: true, filePath: "/repo/docs/configuration.md" })
  })

  it("does not double-emit on partial-then-final readFile events", async () => {
    const out = [
      '{"type":"say","say":"tool","text":"{\\"tool\\":\\"readFile\\",\\"path\\":\\"a.ts\\",\\"content\\":\\"/repo/a.ts\\"}","partial":true}',
      '{"type":"say","say":"tool","text":"{\\"tool\\":\\"readFile\\",\\"path\\":\\"a.ts\\",\\"content\\":\\"/repo/a.ts\\"}","partial":false}',
    ]
    let calls = 0
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "tool-call") calls++
    }
    expect(calls).toBe(1)
  })

  it("surfaces cline tool output content for search/list events", async () => {
    const out = [
      '{"type":"say","say":"tool","text":"{\\"tool\\":\\"searchFiles\\",\\"path\\":\\"src\\",\\"content\\":\\"Found 1 result.\\\\nsrc/index.ts\\"}","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("[cline:searchFiles] src\nFound 1 result.\nsrc/index.ts\n")
  })

  it("extracts human-facing ask text from cline ask payloads", async () => {
    const out = [
      '{"type":"ask","ask":"followup","text":"{\\"question\\":\\"Need input?\\"}","partial":false}',
      '{"type":"ask","ask":"plan_mode_respond","text":"{\\"response\\":\\"Plan text\\"}","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("Need input?Plan text")
  })

  it("reads reasoning from cline's reasoning field when text is absent", async () => {
    const out = ['{"type":"say","say":"reasoning","reasoning":"thinking field"}']
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toBe("thinking field")
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

  it("preserves stdout from bash in runOnce.text (not just in stream tool-result)", async () => {
    // Reads from the buffered runOnce path — earlier code only forwarded
    // `output` field, dropping bash stdout (which uses `stdout`). Here
    // both fields must propagate so doGenerate consumers see command
    // output too.
    const out = [
      '{"type":"say","say":"command","text":"echo hi","partial":false}',
      '{"type":"ask","ask":"command_output","text":"hi-output\\n","partial":false}',
    ]
    const result = await runOnce({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })
    expect(result.text).toContain("[cline:execute_command] echo hi")
    expect(result.text).toContain("hi-output")
  })

  it("ignores partial command_output events and waits for the final one to pair the bash tool-call", async () => {
    const out = [
      '{"type":"say","say":"command","text":"long","partial":false}',
      '{"type":"ask","ask":"command_output","text":"part1","partial":true}',
      '{"type":"ask","ask":"command_output","text":"part1\\npart2-final","partial":false}',
    ]
    const results: Array<{ stdout: string }> = []
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "tool-result" && ev.toolName === "bash") {
        results.push({
          stdout: typeof ev.result["stdout"] === "string" ? (ev.result["stdout"] as string) : "",
        })
      }
    }
    // Exactly ONE tool-result, sourced from the FINAL event (not the partial).
    expect(results).toHaveLength(1)
    expect(results[0]!.stdout).toBe("part1\npart2-final")
  })

  it("flushes a pending bash tool-call on stream END so the tool-result is never orphaned", async () => {
    // cline emits the command but exits before the ask.command_output
    // (subprocess crash, timeout, abort). The runner must still close
    // out the bash tool-call so opencode's session processor doesn't
    // see a tool-call without a matching tool-result.
    const out = [
      '{"type":"say","say":"command","text":"sleep 100","partial":false}',
      // no ask.command_output — stream just ends
    ]
    let callId: string | null = null
    let resultPaired = false
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "tool-call" && ev.toolName === "bash") callId = ev.toolCallId
      if (ev.type === "tool-result" && ev.toolName === "bash" && ev.toolCallId === callId) {
        resultPaired = true
      }
    }
    expect(callId).not.toBeNull()
    expect(resultPaired).toBe(true)
  })

  it("pairs back-to-back say.command events with their respective ask.command_output (no orphaned bash result)", async () => {
    // Stress test the pendingBashCall race-guard: two commands fire
    // without an intervening output; the runner must close the first
    // one with an empty stdout BEFORE arming the second, then attach
    // the next output to the second call (not the first).
    const out = [
      '{"type":"say","say":"command","text":"echo one","partial":false}',
      '{"type":"say","say":"command","text":"echo two","partial":false}',
      '{"type":"ask","ask":"command_output","text":"two-output\\n","partial":false}',
    ]
    const calls: Array<{ id: string; cmd: string }> = []
    const results: Array<{ id: string; stdout: string }> = []
    for await (const ev of runStream({
      prompt: "ignored",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fakeSpawn(out),
    })) {
      if (ev.type === "tool-call" && ev.toolName === "bash") {
        calls.push({
          id: ev.toolCallId,
          cmd: typeof ev.input["command"] === "string" ? (ev.input["command"] as string) : "",
        })
      }
      if (ev.type === "tool-result" && ev.toolName === "bash") {
        results.push({
          id: ev.toolCallId,
          stdout: typeof ev.result["stdout"] === "string" ? (ev.result["stdout"] as string) : "",
        })
      }
    }
    expect(calls.map((c) => c.cmd)).toEqual(["echo one", "echo two"])
    // First call closed with empty stdout when second arrived; second
    // received the actual output.
    expect(results).toHaveLength(2)
    expect(results[0]!.id).toBe(calls[0]!.id)
    expect(results[0]!.stdout).toBe("")
    expect(results[1]!.id).toBe(calls[1]!.id)
    expect(results[1]!.stdout).toBe("two-output\n")
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

  it("doGenerate converts opencode-call tags into tool-call content when the tool is registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-tool-generate-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        // skill tool's actual input shape per opencode-ai 1.14.x is { name }
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: '<opencode-call name=\"skill\">{\"name\":\"code-review\"}</opencode-call>', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: "review" }],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      expect(result.finishReason.unified).toBe("tool-calls")
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toMatchObject({
        type: "tool-call",
        toolName: "skill",
        input: JSON.stringify({ name: "code-review" }),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doGenerate leaves opencode-call tags as text when the tool is not registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-tool-unregistered-"))
    const fakeCline = join(dir, "cline")
    const tag = '<opencode-call name="skill">{"name":"code-review"}</opencode-call>'
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: ${JSON.stringify(tag)}, partial: false }) + '\\n')`,
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: "review" }],
        tools: [{ type: "function", name: "task" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      expect(result.finishReason.unified).toBe("stop")
      expect(result.content).toEqual([{ type: "text", text: tag }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doStream converts streamed opencode-call tags into tool-call events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-tool-stream-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "const parts = ['before ', '<opencode-', 'call name=\"skill\">{\"name\":\"code-review\"}</opencode-call>', ' after']",
        "for (const text of parts) process.stdout.write(JSON.stringify({ type: 'say', say: 'text', text, partial: true }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const streamResult = await model.doStream({
        prompt: [{ role: "user", content: "review" }],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doStream>[0])
      const reader = streamResult.stream.getReader()
      const events: unknown[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }

      expect(events).toContainEqual(expect.objectContaining({ type: "tool-call", toolName: "skill", input: JSON.stringify({ name: "code-review" }) }))
      expect(events).toContainEqual(expect.objectContaining({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        providerMetadata: { cline: expect.objectContaining({ opencodeCalls: 1 }) },
      }))
      const text = events
        .filter((event): event is { type: "text-delta"; delta: string } =>
          typeof event === "object" && event !== null && (event as { type?: unknown }).type === "text-delta",
        )
        .map((event) => event.delta)
        .join("")
      expect(text).toBe("before  after")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doStream flushes a buffered partial tag as text when cline errors out mid-tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-tool-error-flush-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        // Emit a partial-open marker via say.text, then crash with non-zero exit.
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'text', text: 'lead-up <opencode-', partial: true }) + '\\n')",
        "process.exit(7)",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const streamResult = await model.doStream({
        prompt: [{ role: "user", content: "go" }],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doStream>[0])
      const reader = streamResult.stream.getReader()
      const deltas: string[] = []
      let errorSeen = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        const v = value as { type: string; delta?: string }
        if (v.type === "text-delta" && typeof v.delta === "string") deltas.push(v.delta)
        if (v.type === "error") errorSeen = true
      }
      expect(errorSeen).toBe(true)
      // The full "lead-up <opencode-" must reach the consumer — none of it
      // may be silently dropped just because the open-marker prefix was
      // mid-flight when cline crashed.
      expect(deltas.join("")).toContain("lead-up <opencode-")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doGenerate bypasses cline and dispatches a skill tool-call when a slash-command instruction is present", async () => {
    // Use a sentinel fakeCline that would FAIL if invoked — proving the
    // bypass actually short-circuits before cline is spawned.
    const dir = mkdtempSync(join(tmpdir(), "cline-skill-bypass-"))
    const fakeCline = join(dir, "cline-must-not-run")
    writeFileSync(fakeCline, "#!/usr/bin/env bash\nexit 99\n", "utf8")
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `karpathy-guidelines` skill workflow on the user's request.\n</command-instruction>\n\nReview install.sh.",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toMatchObject({
        type: "tool-call",
        toolName: "skill",
        input: JSON.stringify({ name: "karpathy-guidelines" }),
      })
      expect(
        (result.providerMetadata?.["cline"] as { skillSlashBypass?: string })?.skillSlashBypass,
      ).toBe("karpathy-guidelines")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doStream bypasses cline and dispatches a skill tool-call for a slash command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-skill-bypass-stream-"))
    const fakeCline = join(dir, "cline-must-not-run")
    writeFileSync(fakeCline, "#!/usr/bin/env bash\nexit 99\n", "utf8")
    chmodSync(fakeCline, 0o755)

    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const streamResult = await model.doStream({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `code-review` skill workflow on the user's request.\n</command-instruction>\n\nReview my changes.",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doStream>[0])

      const reader = streamResult.stream.getReader()
      const events: unknown[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          toolName: "skill",
          input: JSON.stringify({ name: "code-review" }),
        }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "skill-slash-bypass" },
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT re-dispatch a skill that was already loaded earlier in the conversation (loop guard)", async () => {
    // codex P1 regression: after the slash bypass emits a skill tool-call,
    // opencode runs the skill and re-enters us with the ORIGINAL user
    // message (still carrying <command-instruction>) PLUS a new tool-
    // result. If we don't notice the prior dispatch we re-emit the same
    // skill tool-call — infinite loop. The guard must see the prior
    // <tool-call name="skill"> in the handoff and fall through to cline.
    const dir = mkdtempSync(join(tmpdir(), "cline-loop-guard-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'follow-up answer', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `karpathy-guidelines` skill workflow on the user's request.\n</command-instruction>\nDo the thing.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "prev-1",
                toolName: "skill",
                args: { name: "karpathy-guidelines" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "prev-1",
                toolName: "skill",
                output: { name: "karpathy-guidelines", loaded: true },
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      // Bypass MUST NOT fire again — normal cline flow finished with stop.
      expect(result.finishReason).toMatchObject({ unified: "stop" })
      expect(result.content[0]).toMatchObject({ type: "text", text: "follow-up answer" })
      const meta = result.providerMetadata?.["cline"] as
        | { skillBypassSource?: string; skillSlashBypass?: string }
        | undefined
      expect(meta?.skillBypassSource).toBeUndefined()
      expect(meta?.skillSlashBypass).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("DOES dispatch a DIFFERENT skill in the same conversation (loop guard is name-specific)", async () => {
    // The guard must only block the EXACT skill name that was already
    // dispatched. A second, different slash command in the same chat
    // should still bypass cleanly.
    const dir = mkdtempSync(join(tmpdir(), "cline-loop-guard-chain-"))
    const fakeCline = join(dir, "cline-must-not-run")
    writeFileSync(fakeCline, "#!/usr/bin/env bash\nexit 99\n", "utf8")
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          { role: "user", content: "/karpathy" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "prev-1",
                toolName: "skill",
                args: { name: "karpathy-guidelines" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "prev-1",
                toolName: "skill",
                output: { name: "karpathy-guidelines", loaded: true },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `code-review` skill workflow on the user's request.\n</command-instruction>",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      // Different skill — must dispatch.
      expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
      expect(result.content[0]).toMatchObject({
        type: "tool-call",
        toolName: "skill",
        input: JSON.stringify({ name: "code-review" }),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loop guard fires when prior assistant tool-call uses AI SDK V3 `input` field (not legacy `args`)", async () => {
    // Regression: AI SDK V3 tool-call parts carry `input`, not `args`. The
    // handoff serializer must read both shapes — otherwise the loop guard
    // sees `<tool-call name="skill">undefined</tool-call>`, fails to match
    // the prior `"name":"X"`, and re-emits the same skill tool-call every
    // turn. Symptom: opencode TUI repeats `-> Skill "<id>"` indefinitely.
    const dir = mkdtempSync(join(tmpdir(), "cline-loop-guard-input-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'follow-up answer', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `karpathy-guidelines` skill workflow on the user's request.\n</command-instruction>\nDo the thing.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                // V3 shape: `input` (object), no `args`.
                type: "tool-call",
                toolCallId: "prev-1",
                toolName: "skill",
                input: { name: "karpathy-guidelines" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "prev-1",
                toolName: "skill",
                output: { name: "karpathy-guidelines", loaded: true },
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      expect(result.finishReason).toMatchObject({ unified: "stop" })
      expect(result.content[0]).toMatchObject({ type: "text", text: "follow-up answer" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loop guard fires when prior assistant tool-call `input` is a JSON string (V3 stringified shape)", async () => {
    // Some SDK versions / providers pre-stringify the tool-call input. The
    // handoff must JSON.parse string payloads so the rendered tag carries
    // an object literal — otherwise the value comes through escaped as
    // `"{\"name\":\"X\"}"` and the loop-guard regex misses `"name":"X"`.
    const dir = mkdtempSync(join(tmpdir(), "cline-loop-guard-strinput-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'follow-up answer', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `karpathy-guidelines` skill workflow on the user's request.\n</command-instruction>",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "prev-1",
                toolName: "skill",
                input: JSON.stringify({ name: "karpathy-guidelines" }),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "prev-1",
                toolName: "skill",
                output: { name: "karpathy-guidelines", loaded: true },
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])

      expect(result.finishReason).toMatchObject({ unified: "stop" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does NOT bypass when the `skill` tool isn't registered (falls through to normal cline flow)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-skill-no-bypass-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'normal cline output', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-instruction>\nRun the `code-review` skill workflow on the user's request.\n</command-instruction>",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "task" }], // no skill — bypass must NOT fire
      } as unknown as Parameters<typeof model.doGenerate>[0])
      expect(result.finishReason).toMatchObject({ unified: "stop" })
      expect(result.content[0]).toMatchObject({ type: "text", text: "normal cline output" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("bridges cline's execute_command to opencode bash with stdout result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-bash-bridge-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'command', text: 'echo hello', partial: false }) + '\\n')",
        "process.stdout.write(JSON.stringify({ type: 'ask', ask: 'command_output', text: 'hello\\n', partial: false }) + '\\n')",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'done', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const streamResult = await model.doStream({
        prompt: [{ role: "user", content: "run echo" }],
      } as unknown as Parameters<typeof model.doStream>[0])
      const reader = streamResult.stream.getReader()
      const events: unknown[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          toolName: "bash",
          input: JSON.stringify({ command: "echo hello" }),
        }),
      )
      const toolResult = events.find(
        (e): e is { type: "tool-result"; toolName: string; result: { stdout?: string } } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: unknown }).type === "tool-result" &&
          (e as { toolName?: unknown }).toolName === "bash",
      )
      expect(toolResult).toBeDefined()
      expect(toolResult!.result).toMatchObject({ ok: true, stdout: "hello\n" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes prompt diagnostics for generate and stream calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-promptlog-"))
    const fakeCline = join(dir, "cline")
    const promptLog = join(dir, "prompt.log")
    const previous = process.env["OPENCODE_ANYCLI_PROMPTLOG"]
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'say', say: 'completion_result', text: 'ok', partial: false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)

    try {
      process.env["OPENCODE_ANYCLI_PROMPTLOG"] = promptLog
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const prompt = [
        { role: "system", content: "system rule" },
        { role: "user", content: "user request" },
      ] as unknown as Parameters<typeof model.doGenerate>[0]["prompt"]

      await model.doGenerate({ prompt } as unknown as Parameters<typeof model.doGenerate>[0])
      const streamResult = await model.doStream({ prompt } as unknown as Parameters<typeof model.doStream>[0])
      const reader = streamResult.stream.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }

      const log = readFileSync(promptLog, "utf8")
      expect(log).toContain('"mode": "generate"')
      expect(log).toContain('"mode": "stream"')
      expect(log).toContain('"handoffBytes"')
      expect(log).toContain('"flattenedBytes"')
      expect(log).toContain('"originalBytes"')
      expect(log).toContain('"messageBreakdown"')
      expect(log).toContain("[CURRENT_USER_REQUEST]\\nuser request\\n[/CURRENT_USER_REQUEST]")
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_ANYCLI_PROMPTLOG"]
      else process.env["OPENCODE_ANYCLI_PROMPTLOG"] = previous
      rmSync(dir, { recursive: true, force: true })
    }
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
