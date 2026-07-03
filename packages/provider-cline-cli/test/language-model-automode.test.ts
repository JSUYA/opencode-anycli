import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/cline-capabilities.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, detectAcpSupport: vi.fn() }
})
vi.mock("../src/cline-acp-runner.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, runStreamAcp: vi.fn() }
})
vi.mock("../src/cline-runner.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, runStream: vi.fn() }
})

import { detectAcpSupport } from "../src/cline-capabilities.js"
import { runStreamAcp } from "../src/cline-acp-runner.js"
import { runStream } from "../src/cline-runner.js"
import { ClineLanguageModel } from "../src/language-model.js"

const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: undefined }
const fn = (x: unknown) => x as unknown as ReturnType<typeof vi.fn>
async function* finishOnly() {
  yield { type: "finish", usage, parseErrors: 0 }
}

async function drain(model: ClineLanguageModel) {
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as any)
  const reader = stream.getReader()
  for (;;) { const { done } = await reader.read(); if (done) break }
}

describe("auto mode resolution", () => {
  beforeEach(() => {
    fn(runStreamAcp).mockReset().mockImplementation(finishOnly)
    fn(runStream).mockReset().mockImplementation(finishOnly)
  })

  it("uses ACP runner when --acp is supported", async () => {
    fn(detectAcpSupport).mockResolvedValue(true)
    await drain(new ClineLanguageModel("GaussO4.1-CLI", { cli: "cline", mode: "auto" }))
    expect(fn(runStreamAcp)).toHaveBeenCalled()
    expect(fn(runStream)).not.toHaveBeenCalled()
  })

  it("uses subprocess runner when --acp is NOT supported", async () => {
    fn(detectAcpSupport).mockResolvedValue(false)
    await drain(new ClineLanguageModel("GaussO4.1-CLI", { cli: "cline", mode: "auto" }))
    expect(fn(runStream)).toHaveBeenCalled()
    expect(fn(runStreamAcp)).not.toHaveBeenCalled()
  })
})
