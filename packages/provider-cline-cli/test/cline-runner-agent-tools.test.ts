// Regression tests: cline 0.6.0 (Samsung cline-sr) emits native tool calls via
// `agent_event` `content_start`/`content_end` with `contentType:"tool"` — NOT the
// legacy `say.tool` / `say.command` events. The runner must bridge this new
// schema to opencode V3 tool-call / tool-result stream parts.
//
// The NDJSON fixtures below are byte-for-byte captures from cline 0.6.0.
import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { runStream, type StreamEvent } from "../src/cline-runner.js"

interface FakeProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  pid: number
  killed: boolean
  kill: (sig?: NodeJS.Signals | number) => boolean
}

function makeFakeProc(stdoutLines: string[]): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 4242
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    return true
  }
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  setTimeout(() => {
    for (const line of stdoutLines) proc.stdout.push(line + "\n")
    proc.stdout.push(null)
    proc.stderr.push(null)
    setTimeout(() => proc.emit("close", 0, null), 5)
  }, 0)
  return proc
}

function spawnWith(stdoutLines: string[]) {
  return ((_cmd: string, _args?: readonly string[], _options?: object) =>
    makeFakeProc(stdoutLines) as unknown as ChildProcessWithoutNullStreams) as unknown as typeof import("node:child_process").spawn
}

async function collect(stdoutLines: string[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of runStream({
    prompt: "p",
    usePromptFile: false,
    options: { command: "cline", timeoutMs: 5000, model: "GaussO4.1-CLI" },
    spawnFn: spawnWith(stdoutLines),
  })) {
    events.push(ev)
  }
  return events
}

// ─── Real cline 0.6.0 captures ──────────────────────────────────────────────

const READ_FILES = [
  '{"type":"hook_event","hookEventName":"tool_call","taskId":"conv_1"}',
  '{"type":"agent_event","event":{"type":"content_start","contentType":"tool","toolCallId":"call_R","toolName":"read_files","input":{"files":[{"path":"/tmp/acptest_read.txt"}]}}}',
  '{"type":"hook_event","hookEventName":"tool_result","taskId":"conv_1"}',
  '{"type":"agent_event","event":{"type":"content_end","contentType":"tool","toolCallId":"call_R","toolName":"read_files","output":[{"query":"/tmp/acptest_read.txt","result":"1 | hello from testfile line1\\n2 | line2 secret=42","success":true}]}}',
]

const RUN_COMMANDS = [
  '{"type":"agent_event","event":{"type":"content_start","contentType":"tool","toolCallId":"call_C","toolName":"run_commands","input":{"commands":["echo HELLO_ACP"]}}}',
  '{"type":"agent_event","event":{"type":"content_end","contentType":"tool","toolCallId":"call_C","toolName":"run_commands","output":[{"query":"echo HELLO_ACP","result":"HELLO_ACP\\n","success":true}]}}',
]

const EDITOR_WRITE = [
  '{"type":"agent_event","event":{"type":"content_start","contentType":"tool","toolCallId":"call_E","toolName":"editor","input":{"path":"/tmp/acp_out.txt","new_text":"DONE_ACP"}}}',
  '{"type":"agent_event","event":{"type":"content_end","contentType":"tool","toolCallId":"call_E","toolName":"editor","output":{"query":"edit:/tmp/acp_out.txt","result":"File created successfully at: /tmp/acp_out.txt","success":true}}}',
]

describe("cline 0.6.0 agent_event tool bridging", () => {
  it("bridges read_files → opencode read tool-call + result", async () => {
    const events = await collect(READ_FILES)
    const call = events.find((e) => e.type === "tool-call") as Extract<StreamEvent, { type: "tool-call" }>
    expect(call).toBeDefined()
    expect(call.toolName).toBe("read")
    expect(call.input["filePath"]).toBe("/tmp/acptest_read.txt")
    const result = events.find((e) => e.type === "tool-result") as Extract<StreamEvent, { type: "tool-result" }>
    expect(result).toBeDefined()
    expect(result.toolName).toBe("read")
  })

  it("bridges run_commands → opencode bash tool-call + result with stdout", async () => {
    const events = await collect(RUN_COMMANDS)
    const call = events.find((e) => e.type === "tool-call") as Extract<StreamEvent, { type: "tool-call" }>
    expect(call).toBeDefined()
    expect(call.toolName).toBe("bash")
    expect(call.input["command"]).toBe("echo HELLO_ACP")
    const result = events.find((e) => e.type === "tool-result") as Extract<StreamEvent, { type: "tool-result" }>
    expect(result).toBeDefined()
    expect(String(result.result["stdout"] ?? result.result["output"] ?? "")).toContain("HELLO_ACP")
  })

  it("bridges editor (new file) → opencode write tool-call + result", async () => {
    const events = await collect(EDITOR_WRITE)
    const call = events.find((e) => e.type === "tool-call") as Extract<StreamEvent, { type: "tool-call" }>
    expect(call).toBeDefined()
    expect(["write", "edit"]).toContain(call.toolName)
    expect(call.input["filePath"]).toBe("/tmp/acp_out.txt")
    const result = events.find((e) => e.type === "tool-result") as Extract<StreamEvent, { type: "tool-result" }>
    expect(result).toBeDefined()
  })

  it("does not drop the final answer text on the new schema", async () => {
    const lines = [
      '{"type":"agent_event","event":{"type":"content_start","contentType":"text","text":"Here is the answer."}}',
      ...READ_FILES,
      '{"type":"run_result","finishReason":"stop","text":"Here is the answer.","usage":{"inputTokens":10,"outputTokens":5}}',
    ]
    const events = await collect(lines)
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta).join("")
    expect(text).toContain("Here is the answer.")
    // Tool bridging still fires alongside text.
    expect(events.some((e) => e.type === "tool-call")).toBe(true)
  })
})
