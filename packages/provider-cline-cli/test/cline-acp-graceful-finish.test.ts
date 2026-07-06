import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runStreamAcp } from "../src/cline-acp-runner.js"

const here = dirname(fileURLToPath(import.meta.url))
const hangAgent = join(here, "fixtures", "acp-hang-agent.mjs")
const linux = process.platform === "linux"

describe.skipIf(!linux)("ACP watchdog graceful finish", () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env["OPENCODE_ANYCLI_ACP_IDLE_MS"]
    // Short silence window so the watchdog fires quickly in the test.
    process.env["OPENCODE_ANYCLI_ACP_IDLE_MS"] = "1200"
  })
  afterEach(() => {
    if (prev === undefined) delete process.env["OPENCODE_ANYCLI_ACP_IDLE_MS"]
    else process.env["OPENCODE_ANYCLI_ACP_IDLE_MS"] = prev
  })

  it("finishes the turn (no error) when cline streams then hangs on an ask", async () => {
    const events: string[] = []
    let text = ""
    for await (const ev of runStreamAcp({
      prompt: "investigate the thing",
      usePromptFile: false,
      options: { command: hangAgent, timeoutMs: 0, cwd: process.cwd(), extraArgs: [] },
    })) {
      events.push(ev.type)
      if (ev.type === "text-delta") text += ev.delta
    }
    // The streamed message is preserved and surfaced...
    expect(text).toContain("Continue?")
    // ...the turn ends with a clean finish, NOT an error (which would make
    // opencode retry the same message forever — the "Thinking" loop).
    expect(events).toContain("finish")
    expect(events).not.toContain("error")
  }, 15000)
})
