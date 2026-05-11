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
})
