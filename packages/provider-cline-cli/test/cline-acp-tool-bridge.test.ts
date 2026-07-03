import { describe, it, expect } from "vitest"
import { bridgeAcpTool, buildAcpToolResult } from "../src/cline-tool-bridge.js"

describe("bridgeAcpTool", () => {
  it("maps read (rawInput.path) to opencode read", () => {
    const b = bridgeAcpTool("read", { tool: "readFile", path: "/tmp/a.txt" })
    expect(b).toEqual({ toolName: "read", input: { filePath: "/tmp/a.txt" } })
  })

  it("maps execute (rawInput.command) to opencode bash", () => {
    const b = bridgeAcpTool("execute", { command: "echo hi" })
    expect(b).toEqual({ toolName: "bash", input: { command: "echo hi" } })
  })

  it("maps edit with new_text only to write", () => {
    const b = bridgeAcpTool("edit", { path: "/tmp/a.txt", new_text: "BODY" })
    expect(b).toEqual({ toolName: "write", input: { filePath: "/tmp/a.txt", content: "BODY" } })
  })

  it("maps edit with old_text to edit (in-place)", () => {
    const b = bridgeAcpTool("edit", { path: "/tmp/a.txt", old_text: "X", new_text: "Y" })
    expect(b).toEqual({ toolName: "edit", input: { filePath: "/tmp/a.txt", oldString: "X", newString: "Y" } })
  })

  it("maps search to grep", () => {
    const b = bridgeAcpTool("search", { regex: "foo", path: "src" })
    expect(b).toEqual({ toolName: "grep", input: { pattern: "foo", path: "src" } })
  })

  it("returns null for unmapped kinds", () => {
    expect(bridgeAcpTool("think", {})).toBeNull()
    expect(bridgeAcpTool(undefined, {})).toBeNull()
  })

  it("returns null when required field is missing", () => {
    expect(bridgeAcpTool("read", {})).toBeNull()
    expect(bridgeAcpTool("execute", {})).toBeNull()
  })

  it("builds bash result with stdout and non-bash with output", () => {
    expect(buildAcpToolResult("bash", "OUT\n", null, true)).toEqual({ ok: true, stdout: "OUT\n" })
    expect(buildAcpToolResult("read", { result: "FILE" }, null, true)).toEqual({ ok: true, output: "FILE" })
    expect(buildAcpToolResult("bash", undefined, null, false)).toEqual({ ok: false })
  })
})
