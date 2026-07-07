import { describe, expect, it } from "vitest"

import { emptyClineUsage, runClineTurn, type ClineTurnEvent } from "../src/index.js"
import type { StreamEvent } from "../src/cline-runner.js"

describe("runClineTurn", () => {
  it("stops when the max-turn guard is reached", async () => {
    const prompt = [
      { role: "user", content: "start" },
      ...Array.from({ length: 15 }, (_, i) => ({ role: "assistant", content: `turn ${i}` })),
    ]

    const events = await collect(runClineTurn({ prompt, modelId: "default", maxTurns: 15 }))
    expect(events.some((event) => event.type === "text-delta" && event.delta.includes("Maximum turns"))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", raw: "max-turns-reached" })
  })

  it("extracts registered opencode-call tags from cline text", async () => {
    const events = await collect(
      runClineTurn({
        prompt: [{ role: "user", content: "load skill" }],
        tools: [{ name: "skill" }],
        modelId: "GaussO4.1-CLI",
        runners: {
          detectAcpSupport: async () => false,
          runStream: fakeStream([
            { type: "text-delta", delta: 'before <opencode-call name="skill">{"name":"code-review"}</opencode-call> after' },
            { type: "finish", usage: emptyClineUsage(), parseErrors: 0 },
          ]),
        },
      }),
    )

    const visibleText = events
      .filter((event): event is Extract<ClineTurnEvent, { type: "text-delta" }> => event.type === "text-delta")
      .map((event) => event.delta)
      .join("")
    expect(visibleText).toContain("before")
    expect(visibleText).toContain("after")
    expect(events).toContainEqual(expect.objectContaining({ type: "opencode-call", toolName: "skill", input: { name: "code-review" } }))
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" })
  })

  it("bypasses slash-command skill dispatch before running cline", async () => {
    const events = await collect(
      runClineTurn({
        prompt: [
          {
            role: "user",
            content: "<command-instruction>\nRun the `code-review` skill workflow on the user's request.\n</command-instruction>\nbody.",
          },
        ],
        tools: [{ name: "skill" }],
        modelId: "GaussO4.1-CLI",
      }),
    )

    expect(events).toContainEqual(expect.objectContaining({ type: "opencode-call", toolName: "skill", input: { name: "code-review" } }))
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", raw: "skill-bypass" })
  })

  it("bypasses natural-language skill dispatch before running cline", async () => {
    const events = await collect(
      runClineTurn({
        prompt: [
          { role: "system", content: "<available_skills><skill><name>code-review</name></skill></available_skills>" },
          { role: "user", content: "code-review 스킬로 분석해줘" },
        ],
        tools: [{ name: "skill" }],
        modelId: "GaussO4.1-CLI",
      }),
    )

    expect(events).toContainEqual(expect.objectContaining({ type: "opencode-call", toolName: "skill", input: { name: "code-review" } }))
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", raw: "skill-bypass" })
  })

  it("bypasses subagent dispatch before running cline", async () => {
    const events = await collect(
      runClineTurn({
        prompt: [{ role: "user", content: "@build fix the failing test" }],
        tools: [{ name: "task" }],
        modelId: "GaussO4.1-CLI",
      }),
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "opencode-call",
        toolName: "task",
        input: expect.objectContaining({ subagent_type: "build", prompt: expect.stringContaining("fix the failing test") }),
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", raw: "subagent-bypass" })
  })

  it("does not convert cline-native tool events into opencode calls", async () => {
    const events = await collect(
      runClineTurn({
        prompt: [{ role: "user", content: "read a file" }],
        tools: [{ name: "skill" }],
        modelId: "GaussO4.1-CLI",
        runners: {
          detectAcpSupport: async () => false,
          runStream: fakeStream([
            { type: "tool-call", toolCallId: "read-1", toolName: "read", input: { filePath: "README.md" } },
            { type: "tool-result", toolCallId: "read-1", toolName: "read", result: { content: "ok" } },
            { type: "finish", usage: emptyClineUsage(), parseErrors: 0 },
          ]),
        },
      }),
    )

    expect(events.some((event) => event.type === "opencode-call")).toBe(false)
    expect(events.filter((event) => event.type === "cline-tool")).toHaveLength(2)
  })
})

async function collect(events: AsyncIterable<ClineTurnEvent>): Promise<ClineTurnEvent[]> {
  const out: ClineTurnEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function fakeStream(events: StreamEvent[]): () => AsyncIterable<StreamEvent> {
  return async function* () {
    for (const event of events) yield event
  }
}
