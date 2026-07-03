import { describe, it, expect } from "vitest"
import { translateSessionUpdate } from "../src/cline-acp-runner.js"
import type { StreamEvent } from "../src/cline-runner.js"

function ctx() {
  const events: StreamEvent[] = []
  return {
    events,
    ctx: {
      enqueue: (e: StreamEvent) => events.push(e),
      emittedReads: new Set<string>(),
      assistantState: { acc: "" },
      pendingTools: new Map<string, { toolName: string; kind: string | undefined }>(),
    },
  }
}

describe("translateSessionUpdate — ACP tool bridging", () => {
  it("bridges read tool_call + completed update", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "read", rawInput: { path: "/tmp/a.txt" } } as any, c)
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { result: "FILE" } } as any, c)
    const call = events.find((e) => e.type === "tool-call") as any
    const res = events.find((e) => e.type === "tool-result") as any
    expect(call.toolName).toBe("read")
    expect(call.input.filePath).toBe("/tmp/a.txt")
    expect(res.toolName).toBe("read")
    expect(res.result.output).toBe("FILE")
    expect(res.isError).toBeFalsy()
  })

  it("bridges execute → bash with stdout", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", kind: "execute", rawInput: { command: "echo hi" } } as any, c)
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", rawOutput: "hi\n" } as any, c)
    const call = events.find((e) => e.type === "tool-call") as any
    const res = events.find((e) => e.type === "tool-result") as any
    expect(call.toolName).toBe("bash")
    expect(call.input.command).toBe("echo hi")
    expect(res.result.stdout).toBe("hi\n")
  })

  it("marks failed status as isError", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t3", kind: "execute", rawInput: { command: "false" } } as any, c)
    translateSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "failed", rawOutput: "" } as any, c)
    const res = events.find((e) => e.type === "tool-result") as any
    expect(res.isError).toBe(true)
  })

  it("routes agent_thought_chunk to reasoning-delta (not text)", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } as any, c)
    expect(events).toEqual([{ type: "reasoning-delta", delta: "hmm" }])
  })

  it("emits assistant text via text-delta", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } as any, c)
    expect(events).toEqual([{ type: "text-delta", delta: "answer" }])
  })

  it("emits a text fallback for unmapped kinds", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t4", kind: "fetch", title: "Fetch url", rawInput: {} } as any, c)
    const txt = events.find((e) => e.type === "text-delta") as any
    expect(txt.delta).toContain("fetch")
    expect(events.some((e) => e.type === "tool-call")).toBe(false)
  })

  it("does not emit duplicate read tool-calls for the same file", () => {
    const { events, ctx: c } = ctx()
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "a", kind: "read", rawInput: { path: "/tmp/x" } } as any, c)
    translateSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "b", kind: "read", rawInput: { path: "/tmp/x" } } as any, c)
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1)
  })
})
