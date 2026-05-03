import { describe, it, expect } from "vitest"
import { flattenPrompt } from "../src/prompt-flatten.js"

describe("flattenPrompt", () => {
  it("prepends system messages with [SYSTEM] marker", () => {
    const out = flattenPrompt({
      prompt: [{ role: "system", content: "you are helpful" }],
    })
    expect(out).toContain("[SYSTEM]")
    expect(out).toContain("you are helpful")
  })

  it("wraps user and assistant messages with role markers", () => {
    const out = flattenPrompt({
      prompt: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })
    expect(out).toContain("[USER]")
    expect(out).toContain("[/USER]")
    expect(out).toContain("[ASSISTANT]")
    expect(out).toContain("[/ASSISTANT]")
    expect(out).toContain("hi")
    expect(out).toContain("hello")
  })

  it("preserves user/assistant alternation", () => {
    const out = flattenPrompt({
      prompt: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer1" },
        { role: "user", content: "second" },
      ],
    })
    const userIdx1 = out.indexOf("first")
    const asstIdx = out.indexOf("answer1")
    const userIdx2 = out.indexOf("second")
    expect(userIdx1).toBeLessThan(asstIdx)
    expect(asstIdx).toBeLessThan(userIdx2)
  })

  it("handles array content with text parts", () => {
    const out = flattenPrompt({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      ],
    })
    expect(out).toContain("part one")
    expect(out).toContain("part two")
  })

  it("notes omitted images instead of throwing", () => {
    const out = flattenPrompt({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", image: "(binary)" },
          ],
        },
      ],
    })
    expect(out).toContain("look at this")
    expect(out).toContain("omitted")
  })

  it("handles tool messages", () => {
    const out = flattenPrompt({
      prompt: [
        {
          role: "tool",
          content: [{ type: "tool-result", toolName: "ls", output: { files: ["a.ts"] } }],
        },
      ],
    })
    expect(out).toContain("[TOOL_RESULT]")
    expect(out).toContain("ls")
    expect(out).toContain("a.ts")
  })

  it("returns empty string for empty prompt", () => {
    expect(flattenPrompt({ prompt: [] })).toBe("")
  })

  it("skips messages with empty content", () => {
    const out = flattenPrompt({
      prompt: [
        { role: "system", content: "" },
        { role: "user", content: "hi" },
      ],
    })
    expect(out).not.toContain("[SYSTEM]")
    expect(out).toContain("[USER]")
  })

  it("is defensive against null and non-object messages", () => {
    const out = flattenPrompt({
      prompt: [null, "string", { role: "user", content: "hi" }],
    })
    expect(out).toContain("hi")
  })

  it("handles unknown roles by uppercasing the marker", () => {
    const out = flattenPrompt({
      prompt: [{ role: "developer", content: "note" }],
    })
    expect(out).toContain("[DEVELOPER]")
    expect(out).toContain("[/DEVELOPER]")
  })
})
