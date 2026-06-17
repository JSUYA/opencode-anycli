import { describe, it, expect } from "vitest"
import {
  resolveCliRunProfile,
  deriveModelDef,
  CLAUDE_MODELS,
  CODEX_MODELS,
} from "../src/cli-profiles.js"

describe("deriveModelDef", () => {
  it("resolves registered claude model ids", () => {
    expect(deriveModelDef("claude", "opus-4.8-max")).toEqual({ model: "opus", effort: "max" })
    expect(deriveModelDef("claude", "opus-4.8-xhigh")).toEqual({ model: "opus", effort: "xhigh" })
  })

  it("resolves registered codex model ids", () => {
    expect(deriveModelDef("codex", "gpt-5.5-xhigh")).toEqual({ model: "gpt-5.5", effort: "xhigh" })
  })

  it("splits a trailing effort token off unregistered ids", () => {
    expect(deriveModelDef("claude", "sonnet-4.6-low")).toEqual({ model: "sonnet-4.6", effort: "low" })
    expect(deriveModelDef("codex", "gpt-6-medium")).toEqual({ model: "gpt-6", effort: "medium" })
  })

  it("falls back to whole id + default effort when no effort suffix", () => {
    expect(deriveModelDef("claude", "opus")).toEqual({ model: "opus", effort: "high" })
  })

  it("keeps the registries in sync with the model id keys", () => {
    expect(Object.keys(CLAUDE_MODELS)).toContain("opus-4.8-max")
    expect(Object.keys(CODEX_MODELS)).toContain("gpt-5.5-xhigh")
  })
})

describe("resolveCliRunProfile — claude argv", () => {
  const p = resolveCliRunProfile("claude", "opus-4.8-max", "claude")

  it("builds a stream-json print invocation with the right model + effort", () => {
    expect(p.command).toBe("claude")
    expect(p.label).toBe("claude")
    expect(p.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "opus",
      "--effort",
      "max",
      "--permission-mode",
      "bypassPermissions",
    ])
  })

  it("does NOT put the prompt on argv (delivered via stdin)", () => {
    expect(p.args).not.toContain("opus-4.8-max")
    // no positional prompt token
    expect(p.args[p.args.length - 1]).toBe("bypassPermissions")
  })

  it("applies yolo permission bypass automatically", () => {
    expect(p.args).toContain("--permission-mode")
    expect(p.args).toContain("bypassPermissions")
  })

  it("appends extraArgs after the flavor flags", () => {
    const withExtra = resolveCliRunProfile("claude", "opus-4.8-high", "claude", ["--add-dir", "/tmp"])
    expect(withExtra.args.slice(-2)).toEqual(["--add-dir", "/tmp"])
  })

  it("honors a custom command path", () => {
    const custom = resolveCliRunProfile("claude", "opus-4.8-high", "/opt/claude/bin/claude")
    expect(custom.command).toBe("/opt/claude/bin/claude")
  })
})

describe("resolveCliRunProfile — codex argv", () => {
  const p = resolveCliRunProfile("codex", "gpt-5.5-xhigh", "codex")

  it("builds a codex exec --json invocation with model + reasoning effort", () => {
    expect(p.command).toBe("codex")
    expect(p.label).toBe("codex")
    expect(p.args).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=xhigh",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    ])
  })

  it("applies yolo approval+sandbox bypass automatically", () => {
    expect(p.args).toContain("--dangerously-bypass-approvals-and-sandbox")
  })
})

describe("claude line parser", () => {
  const parse = resolveCliRunProfile("claude", "opus-4.8-high", "claude").parseLine

  it("maps text_delta stream events to text-delta", () => {
    const out = parse({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    })
    expect(out.events).toEqual([{ type: "text-delta", delta: "hi" }])
  })

  it("ignores non-text stream events", () => {
    expect(parse({ type: "stream_event", event: { type: "content_block_start" } }).events).toEqual([])
    expect(parse({ type: "system", subtype: "init" }).events).toEqual([])
    expect(parse({ type: "assistant", message: {} }).events).toEqual([])
  })

  it("extracts usage + cost + context window from the result event", () => {
    const out = parse({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hi",
      total_cost_usd: 0.0679,
      usage: {
        input_tokens: 5255,
        output_tokens: 4,
        cache_read_input_tokens: 15357,
        cache_creation_input_tokens: 3386,
      },
      modelUsage: { "claude-opus-4-8": { contextWindow: 1000000, maxOutputTokens: 64000 } },
    })
    expect(out.usage).toEqual({
      inputTokens: 5255,
      outputTokens: 4,
      cacheReadTokens: 15357,
      cacheWriteTokens: 3386,
      totalTokens: 5259,
      totalCost: 0.0679,
    })
    expect(out.contextMax).toBe(1000000)
    expect(out.fatalError).toBeUndefined()
  })

  it("surfaces a fatal error when result.is_error is true", () => {
    const out = parse({ type: "result", is_error: true, result: "rate limited", usage: {} })
    expect(out.fatalError).toBe("rate limited")
  })
})

describe("codex line parser", () => {
  const parse = resolveCliRunProfile("codex", "gpt-5.5-high", "codex").parseLine

  it("maps an agent_message item to text-delta", () => {
    const out = parse({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "hi" } })
    expect(out.events).toEqual([{ type: "text-delta", delta: "hi" }])
  })

  it("ignores reasoning / error items and lifecycle events", () => {
    expect(parse({ type: "item.completed", item: { type: "reasoning" } }).events).toEqual([])
    expect(parse({ type: "item.completed", item: { type: "error", message: "deprecated flag" } }).events).toEqual([])
    expect(parse({ type: "thread.started", thread_id: "x" }).events).toEqual([])
    expect(parse({ type: "turn.started" }).events).toEqual([])
  })

  it("extracts usage from turn.completed (reasoning folded into output)", () => {
    const out = parse({
      type: "turn.completed",
      usage: { input_tokens: 17102, cached_input_tokens: 2432, output_tokens: 5, reasoning_output_tokens: 3 },
    })
    expect(out.usage).toEqual({
      inputTokens: 17102,
      outputTokens: 8,
      cacheReadTokens: 2432,
      cacheWriteTokens: 0,
      totalTokens: 17110,
      totalCost: undefined,
    })
  })

  it("surfaces a fatal error on turn.failed", () => {
    const out = parse({ type: "turn.failed", error: { message: "model overloaded" } })
    expect(out.fatalError).toBe("model overloaded")
  })
})
