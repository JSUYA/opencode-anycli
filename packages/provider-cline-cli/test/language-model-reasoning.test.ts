import { describe, it, expect, vi } from "vitest"

vi.mock("../src/cline-acp-runner.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, runStreamAcp: vi.fn() }
})

import { runStreamAcp } from "../src/cline-acp-runner.js"
import { ClineLanguageModel } from "../src/language-model.js"

async function collectParts(model: ClineLanguageModel) {
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as any)
  const parts: any[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

describe("doStream reasoning parts (ACP)", () => {
  it("emits reasoning-start/delta/end before text", async () => {
    ;(runStreamAcp as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "reasoning-delta", delta: "think " }
      yield { type: "reasoning-delta", delta: "more" }
      yield { type: "text-delta", delta: "ANSWER" }
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 2, totalCost: undefined }, parseErrors: 0 }
    })
    const model = new ClineLanguageModel("GaussO4.1-CLI", { cli: "cline", mode: "acp" })
    const parts = await collectParts(model)
    const types = parts.map((p) => p.type)
    expect(types).toContain("reasoning-start")
    expect(types).toContain("reasoning-delta")
    expect(types).toContain("reasoning-end")
    // reasoning-end precedes the first text-start
    expect(types.indexOf("reasoning-end")).toBeLessThan(types.indexOf("text-start"))
    const rtext = parts.filter((p) => p.type === "reasoning-delta").map((p) => p.delta).join("")
    expect(rtext).toBe("think more")
  })
})
