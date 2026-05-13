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
    expect(result.usage.totalTokens).toBe(16374)
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
