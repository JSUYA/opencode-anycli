import { describe, expect, it } from "vitest"
import {
  bridgeClineCommandStart,
  bridgeClineToolEvent,
  buildCommandOutputResult,
  normalizeClineToolName,
  resolveOpencodeTool,
} from "../src/cline-tool-bridge.js"

describe("normalizeClineToolName", () => {
  it("collapses casing, underscores, and dashes", () => {
    expect(normalizeClineToolName("readFile")).toBe("readfile")
    expect(normalizeClineToolName("read_file")).toBe("readfile")
    expect(normalizeClineToolName("Read-File")).toBe("readfile")
  })
})

describe("resolveOpencodeTool", () => {
  it.each([
    ["readFile", "read"],
    ["read_file", "read"],
    ["write_to_file", "write"],
    ["writeToFile", "write"],
    ["replace_in_file", "edit"],
    ["apply_diff", "edit"],
    ["execute_command", "bash"],
    ["search_files", "grep"],
    ["list_files", "glob"],
    ["web_fetch", "webfetch"],
    ["web_search", "websearch"],
  ])("maps %s → %s", (cline, opencode) => {
    expect(resolveOpencodeTool(cline)).toBe(opencode)
  })

  it("returns null for unknown cline tools (forward-compat path)", () => {
    expect(resolveOpencodeTool("brand_new_cline_tool_2099")).toBeNull()
  })
})

describe("bridgeClineToolEvent", () => {
  it("bridges readFile with offset+limit", () => {
    const ev = bridgeClineToolEvent({
      tool: "readFile",
      path: "src/index.ts",
      content: "/repo/src/index.ts",
      readLineStart: 10,
      readLineEnd: 50,
    })
    expect(ev).not.toBeNull()
    expect(ev!.toolName).toBe("read")
    expect(ev!.input).toEqual({ filePath: "/repo/src/index.ts", offset: 10, limit: 41 })
    expect(ev!.ok).toBe(true)
    expect(ev!.originalClineName).toBe("readFile")
  })

  it("bridges write_to_file → write with file body preserved", () => {
    const body = "line1\nline2\nline3".repeat(20)
    const ev = bridgeClineToolEvent({
      tool: "write_to_file",
      path: "out.txt",
      content: body,
    })
    expect(ev!.toolName).toBe("write")
    // filePath MUST come from `path`, not from `content` — cline's write
    // tool puts the body in `content` and would corrupt the filename
    // assignment if we treated `content` as a path fallback (see
    // reviewer regression notes in cline-tool-bridge.ts:write).
    expect(ev!.input["filePath"]).toBe("out.txt")
    expect(ev!.input["content"]).toBe(body)
  })

  it("bridges replace_in_file → edit and keeps filePath from `path`, diff from `diff`", () => {
    const ev = bridgeClineToolEvent({
      tool: "replace_in_file",
      path: "src/a.ts",
      diff: "@@ -1 +1 @@\n-old\n+new",
    })
    expect(ev!.toolName).toBe("edit")
    expect(ev!.input["filePath"]).toBe("src/a.ts")
    expect(ev!.input["diff"]).toContain("-old")
  })

  it("bridges search_files → grep and preserves output body", () => {
    const ev = bridgeClineToolEvent({
      tool: "search_files",
      path: "src",
      regex: "TODO",
      content: "src/a.ts:12: // TODO\nsrc/b.ts:7: // TODO",
    })
    expect(ev!.toolName).toBe("grep")
    expect(ev!.input).toMatchObject({ pattern: "TODO", path: "src" })
    expect(ev!.result["output"]).toContain("src/a.ts")
  })

  it("bridges list_files → glob and preserves listing body", () => {
    const ev = bridgeClineToolEvent({
      tool: "list_files",
      path: "src",
      recursive: true,
      content: "src/a.ts\nsrc/b.ts",
    })
    expect(ev!.toolName).toBe("glob")
    expect(ev!.input["pattern"]).toBe("src/**")
    expect(ev!.result["output"]).toContain("src/a.ts")
  })

  it("returns null when payload lacks a tool field", () => {
    expect(bridgeClineToolEvent({ path: "x" })).toBeNull()
  })

  it("falls through unknown tools as cline:<name> (forward-compat)", () => {
    const ev = bridgeClineToolEvent({
      tool: "future_cline_tool_2099",
      some_field: "value",
      another: 42,
    })
    expect(ev).not.toBeNull()
    expect(ev!.toolName).toBe("cline:future_cline_tool_2099")
    expect(ev!.input).toMatchObject({ some_field: "value", another: 42 })
    expect(ev!.input["tool"]).toBeUndefined() // tool key stripped from passthrough
  })

  it("bridges web_fetch → webfetch", () => {
    const ev = bridgeClineToolEvent({ tool: "web_fetch", url: "https://example.com" })
    expect(ev!.toolName).toBe("webfetch")
    expect(ev!.input).toEqual({ url: "https://example.com" })
  })
})

describe("bridgeClineCommandStart", () => {
  it("bridges raw shell command to opencode bash tool-call", () => {
    const ev = bridgeClineCommandStart("git status")
    expect(ev.toolName).toBe("bash")
    expect(ev.input).toEqual({ command: "git status" })
    expect(ev.originalClineName).toBe("execute_command")
  })
})

describe("buildCommandOutputResult", () => {
  it("marks success when exit code is 0 or unknown", () => {
    expect(buildCommandOutputResult("done", 0).ok).toBe(true)
    expect(buildCommandOutputResult("done").ok).toBe(true)
  })

  it("marks error when exit code is non-zero", () => {
    const r = buildCommandOutputResult("err", 1)
    expect(r.ok).toBe(false)
    expect(r.result).toMatchObject({ ok: false, exitCode: 1, stdout: "err" })
  })
})
