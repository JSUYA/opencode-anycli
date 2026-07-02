// Integration tests for tool calling functionality.
import { describe, expect, it } from "vitest"
import { OpencodeCallParser, extractAvailableSkillNames, isSkillAlreadyDispatchedInHandoff } from "../src/opencode-call-parser.js"
import { bridgeClineToolEvent, resolveOpencodeTool } from "../src/cline-tool-bridge.js"

describe("Tool Calling Integration", () => {
  describe("OpencodeCallParser - Complex Scenarios", () => {
    it("handles multiple tool calls interspersed with text", () => {
      const parser = new OpencodeCallParser()
      const input = [
        "First, let me check the code. ",
        '<opencode-call name="skill">{"name":"code-review"}</opencode-call>\n',
        "Now let me search for TODOs. ",
        '<opencode-call name="skill">{"name":"todo-harvester"}</opencode-call>\n',
        "Finally, I'll provide a summary.",
      ].join("")

      const result = parser.feed(input)
      expect(result.calls).toHaveLength(2)
      expect(result.calls[0]).toMatchObject({ toolName: "skill", input: { name: "code-review" } })
      expect(result.calls[1]).toMatchObject({ toolName: "skill", input: { name: "todo-harvester" } })
      expect(result.text).toContain("First, let me check the code.")
      expect(result.text).not.toContain("<opencode-call")
    })

    it("handles deeply nested JSON in tool input", () => {
      const parser = new OpencodeCallParser()
      const complexInput = {
        subagent_type: "architect",
        description: "Analyze structure",
        prompt: "Review: {\n  \"files\": [\"src/index.ts\"],\n  \"depth\": \"deep\"\n}",
      }
      const input = `<opencode-call name="task">${JSON.stringify(complexInput)}</opencode-call>`
      const result = parser.feed(input)
      expect(result.calls).toHaveLength(1)
      expect(result.calls[0].toolName).toBe("task")
      expect(result.calls[0].input).toEqual(complexInput)
    })

    it("handles chunked delivery with CRLF", () => {
      const parser = new OpencodeCallParser()
      const chunks = [
        '<opencode-call name="skill">',
        '{"name":"',
        'code-review"',
        '}</opencode-call>\r\n',
        "Continuing text",
      ]
      const results = chunks.map((chunk) => parser.feed(chunk))
      const allCalls = results.flatMap((r) => r.calls)
      expect(allCalls).toHaveLength(1)
      expect(allCalls[0].toolName).toBe("skill")
      expect(allCalls[0].input).toEqual({ name: "code-review" })
    })

    it("rejects tool call with empty name", () => {
      const parser = new OpencodeCallParser()
      const input = '<opencode-call name="">{"foo":"bar"}</opencode-call>'
      const result = parser.feed(input)
      expect(result.calls).toHaveLength(0)
      expect(result.text).toContain(input)
    })

    it("handles multiple tool calls with different types", () => {
      const parser = new OpencodeCallParser()
      const input = [
        '<opencode-call name="skill">{"name":"lint-fix"}</opencode-call>',
        '<opencode-call name="task">{"subagent_type":"test-writer","description":"write tests","prompt":"add tests"}</opencode-call>',
        '<opencode-call name="skill">{"name":"security-scan"}</opencode-call>',
      ].join("\n")
      const result = parser.feed(input)
      expect(result.calls).toHaveLength(3)
      expect(result.calls.map((c) => c.toolName)).toEqual(["skill", "task", "skill"])
    })
  })

  describe("ClineToolBridge - Integration Scenarios", () => {
    it("bridges a complete cline tool workflow", () => {
      const tools = [
        { tool: "readFile", path: "src/index.ts", content: "/workspace/src/index.ts" },
        { tool: "replace_in_file", path: "src/index.ts", diff: "@@ -10 +10 @@\n-old\n+new" },
        { tool: "execute_command", command: "npm test" },
      ]
      const bridged = tools.map((t) => bridgeClineToolEvent(t))
      expect(bridged[0]?.toolName).toBe("read")
      expect(bridged[1]?.toolName).toBe("edit")
      expect(bridged[2]?.toolName).toBe("bash")
    })

    it("handles tool name variations consistently", () => {
      const variations = [
        { input: "readFile", expected: "read" },
        { input: "read_file", expected: "read" },
        { input: "ReadFile", expected: "read" },
      ]
      for (const { input, expected } of variations) {
        expect(resolveOpencodeTool(input)).toBe(expected)
      }
    })
  })

  describe("Skill Detection Integration", () => {
    it("extracts skill names from available_skills XML", () => {
      const handoff = `
        <available_skills>
          <skill><name>code-review</name></skill>
          <skill><name>karpathy-guidelines</name></skill>
          <skill><name>tizen-sdb-helper</name></skill>
        </available_skills>
      `
      const skills = extractAvailableSkillNames(handoff)
      expect(skills).toEqual(["code-review", "karpathy-guidelines", "tizen-sdb-helper"])
    })

    it("detects skill already dispatched in handoff", () => {
      const handoff = `
        [CURRENT_USER_REQUEST]\nPlease review my code\n[/CURRENT_USER_REQUEST]
        <assistant><tool-call name="skill">{"name":"code-review"}</tool-call></assistant>
      `
      expect(isSkillAlreadyDispatchedInHandoff(handoff, "code-review")).toBe(true)
      expect(isSkillAlreadyDispatchedInHandoff(handoff, "other-skill")).toBe(false)
    })

    it("handles plugin-namespaced skills", () => {
      const handoff = `
        <available_skills>
          <skill><name>caveman:caveman-review</name></skill>
          <skill><name>github:gh-address-comments</name></skill>
        </available_skills>
      `
      const skills = extractAvailableSkillNames(handoff)
      expect(skills).toContain("caveman:caveman-review")
      expect(skills).toContain("github:gh-address-comments")
    })
  })

  describe("Edge Cases and Error Handling", () => {
    it("handles malformed JSON gracefully", () => {
      const parser = new OpencodeCallParser()
      const malformed = '<opencode-call name="skill">{invalid json}</opencode-call>'
      const result = parser.feed(malformed)
      expect(result.calls).toHaveLength(0)
      expect(result.text).toContain(malformed)
    })

    it("handles unclosed tag at stream end", () => {
      const parser = new OpencodeCallParser()
      parser.feed('<opencode-call name="skill">{"name":"test"')
      const flush = parser.flush()
      expect(flush.calls).toHaveLength(0)
      expect(flush.text).toBe('<opencode-call name="skill">{"name":"test"')
    })

    it("handles unicode in tool input", () => {
      const parser = new OpencodeCallParser()
      const input = '<opencode-call name="skill">{"name":"test","message":"안녕하세요 世界 🌍"}</opencode-call>'
      const result = parser.feed(input)
      expect(result.calls).toHaveLength(1)
      expect(result.calls[0].input).toEqual({ name: "test", message: "안녕하세요 世界 🌍" })
    })
  })

  describe("Protocol Compliance", () => {
    it("accepts both single and double quotes", () => {
      const parser = new OpencodeCallParser()
      const doubleQuote = '<opencode-call name="skill">{}</opencode-call>'
      const singleQuote = "<opencode-call name='skill'>{}</opencode-call>"
      expect(parser.feed(doubleQuote).calls).toHaveLength(1)
      expect(parser.feed(singleQuote).calls).toHaveLength(1)
    })

    it("maintains order of multiple tool calls", () => {
      const parser = new OpencodeCallParser()
      const calls = Array.from({ length: 5 }, (_, i) =>
        `<opencode-call name="skill">{"name":"skill-${i}"}</opencode-call>`,
      ).join("\n")
      const result = parser.feed(calls)
      expect(result.calls).toHaveLength(5)
      result.calls.forEach((call, index) => {
        expect((call.input as any).name).toBe(`skill-${index}`)
      })
    })
  })

  describe("Real World Scenarios", () => {
    it("simulates a code review workflow", () => {
      const parser = new OpencodeCallParser()
      const skillCall = '<opencode-call name="skill">{"name":"code-review"}</opencode-call>'
      const modelResponse = `I'll help.\n\n${skillCall}\n\nLet me analyze.`
      const result = parser.feed(modelResponse)
      expect(result.calls).toHaveLength(1)
      expect(result.calls[0].toolName).toBe("skill")
      expect(result.calls[0].input).toEqual({ name: "code-review" })
    })

    it("handles interleaved thinking and tool calls", () => {
      const parser = new OpencodeCallParser()
      const response = `
        Let me think...
        <opencode-call name="skill">{"name":"find-skills"}</opencode-call>
        Now I can proceed.
        <opencode-call name="skill">{"name":"code-review"}</opencode-call>
        Done!
      `
      const result = parser.feed(response)
      expect(result.calls).toHaveLength(2)
      expect(result.text).toContain("Let me think...")
      expect(result.text).toContain("Done!")
      expect(result.text).not.toContain("<opencode-call")
    })
  })
})
