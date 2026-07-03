import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readPersistedTaskUsage } from "../src/cline-runner.js"

describe("readPersistedTaskUsage (exported, used by ACP usage recovery)", () => {
  it("reads tokens from a task's ui_messages.json via --config data dir", () => {
    const cfg = mkdtempSync(join(tmpdir(), "acp-usage-"))
    const taskId = "conv_test_1"
    const taskDir = join(cfg, "data", "tasks", taskId)
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(
      join(taskDir, "ui_messages.json"),
      JSON.stringify([
        { type: "say", say: "api_req_finished", ts: 1, tokensIn: 100, tokensOut: 20 },
        { type: "say", say: "api_req_finished", ts: 2, tokensIn: 1234, tokensOut: 56, cacheReads: 7 },
      ]),
    )
    const usage = readPersistedTaskUsage(taskId, {
      command: "cline",
      timeoutMs: 0,
      extraArgs: ["--config", cfg],
    } as any)
    expect(usage).not.toBeNull()
    // Latest ts wins (not summed).
    expect(usage!.inputTokens).toBe(1234)
    expect(usage!.outputTokens).toBe(56)
    expect(usage!.cacheReadTokens).toBe(7)
  })

  it("returns null when the task dir has no usage files", () => {
    const cfg = mkdtempSync(join(tmpdir(), "acp-usage-empty-"))
    mkdirSync(join(cfg, "data", "tasks", "empty"), { recursive: true })
    expect(readPersistedTaskUsage("empty", { command: "cline", timeoutMs: 0, extraArgs: ["--config", cfg] } as any)).toBeNull()
  })
})
