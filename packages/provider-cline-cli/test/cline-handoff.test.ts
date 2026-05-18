import { describe, expect, it } from "vitest"
import { composeClineHandoff } from "../src/cline-handoff.js"

describe("composeClineHandoff", () => {
  it("separates the latest user request from prior conversation context", () => {
    const result = composeClineHandoff({
      prompt: [
        { role: "system", content: "system rule" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current request" },
      ],
    })

    expect(result.text).toContain("[CURRENT_USER_REQUEST]\ncurrent request")
    expect(result.text).toContain("[INSTRUCTIONS]\n<system")
    expect(result.text).toContain("system rule")
    expect(result.text).toContain("[RELEVANT_CONTEXT]")
    expect(result.text).toContain("old question")
    expect(result.text).toContain("old answer")
    expect(result.diagnostics.messageBreakdown.at(-1)?.handoffSection).toBe("current_user_request")
  })

  it("extracts command instructions and removes handoff policy blocks from model-visible content", () => {
    const result = composeClineHandoff({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<command-instruction>",
                "Run the code-review workflow.",
                "</command-instruction>",
                '<handoff-context-policy id="diff-review">',
                "keep: latest_user, git_diff",
                "</handoff-context-policy>",
                "review this branch",
              ].join("\n"),
            },
          ],
        },
      ],
    })

    expect(result.text).toContain("[CURRENT_USER_REQUEST]\nreview this branch")
    expect(result.text).toContain("[INSTRUCTIONS]\nRun the code-review workflow.")
    expect(result.text).toContain("[CONTEXT_POLICY]\nid: diff-review")
    expect(result.text).not.toContain("keep: latest_user")
    expect(result.text).not.toContain("handoff-context-policy")
    expect(result.diagnostics.policyId).toBe("diff-review")
  })

  it("applies command policy budgets to older conversation context", () => {
    const oldContext = "old-context-head\n" + "x".repeat(12000) + "\nold-context-tail"
    const result = composeClineHandoff({
      prompt: [
        { role: "assistant", content: oldContext },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                '<handoff-context-policy id="release-git">',
                "keep: latest_user, git_status, staged_diff",
                "</handoff-context-policy>",
                "write a commit message",
              ].join("\n"),
            },
          ],
        },
      ],
    })

    expect(result.diagnostics.policyId).toBe("release-git")
    expect(result.text).toContain("write a commit message")
    expect(result.text).toContain("old-context-head")
    expect(result.text).toContain("old-context-tail")
    expect(result.text).toContain("[assistant context omitted")
    expect(result.text).not.toContain("x".repeat(8000))
  })

  it("keeps tool messages in a dedicated observations section", () => {
    const result = composeClineHandoff({
      prompt: [
        { role: "user", content: "what failed?" },
        { role: "tool", content: [{ type: "tool-result", toolName: "bash", output: { stdout: "ok" } }] },
      ],
    })

    expect(result.text).toContain("[TOOL_OBSERVATIONS]")
    expect(result.text).toContain("<tool-result name=\"bash\">")
    expect(result.diagnostics.messageBreakdown[1]?.handoffSection).toBe("tool_observations")
  })

  it("summarizes large tool output with error-focused head and tail context", () => {
    const middle = "M".repeat(10000)
    const result = composeClineHandoff({
      prompt: [
        { role: "user", content: "diagnose the failing test" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "bash",
              output: {
                command: "npm test",
                exitCode: 1,
                stdout: `stdout-head\n${middle}\nstdout-tail`,
                stderr: `stderr-head\n${middle}\nstderr-tail`,
              },
            },
          ],
        },
      ],
    })

    expect(result.text).toContain("command: npm test")
    expect(result.text).toContain("exitCode: 1")
    expect(result.text).toContain("stderr:")
    expect(result.text).toContain("stderr-head")
    expect(result.text).toContain("stderr-tail")
    expect(result.text).toContain("[stderr omitted")
    expect(result.text).toContain("stdout-head")
    expect(result.text).toContain("stdout-tail")
    expect(result.text).toContain("[stdout omitted")
    expect(result.text).not.toContain("M".repeat(5000))
  })

  it("preserves the latest user request even when tool observations are truncated", () => {
    const request = "current request " + "한글".repeat(1000)
    const result = composeClineHandoff({
      prompt: [
        {
          role: "tool",
          content: [{ type: "tool-result", toolName: "bash", output: { stdout: "x".repeat(10000) } }],
        },
        { role: "user", content: request },
      ],
    })

    expect(result.text).toContain(request)
    expect(result.text).toContain("[stdout omitted")
  })

  it("omits the OPENCODE_CALL_PROTOCOL section when no tools are supplied", () => {
    const result = composeClineHandoff({
      prompt: [{ role: "user", content: "hi" }],
    })
    expect(result.text).not.toContain("[OPENCODE_CALL_PROTOCOL]")
    expect(result.diagnostics.protocolBytes).toBe(0)
  })

  it("omits the protocol section when registered tools are unrelated", () => {
    const result = composeClineHandoff({
      prompt: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash" }, { name: "edit" }],
    })
    expect(result.text).not.toContain("[OPENCODE_CALL_PROTOCOL]")
    expect(result.diagnostics.protocolBytes).toBe(0)
  })

  it("appends the OPENCODE_CALL_PROTOCOL section when task is registered", () => {
    const result = composeClineHandoff({
      prompt: [{ role: "user", content: "review this branch" }],
      tools: [{ name: "task" }, { name: "bash" }],
    })
    expect(result.text).toContain("[OPENCODE_CALL_PROTOCOL]")
    expect(result.text).toContain('<opencode-call name="task">')
    expect(result.text).not.toContain('<opencode-call name="skill">')
    expect(result.diagnostics.protocolBytes).toBeGreaterThan(0)
  })

  it("appends both task and skill lines when both tools are registered", () => {
    const result = composeClineHandoff({
      prompt: [{ role: "user", content: "do work" }],
      tools: [{ name: "task" }, { name: "skill" }, { name: "edit" }],
    })
    expect(result.text).toContain('<opencode-call name="task">')
    expect(result.text).toContain('<opencode-call name="skill">')
  })
})
