import { describe, it, expect } from "vitest"
import type { StreamEvent } from "../src/cline-runner.js"
import type { ClineMode } from "../src/types.js"

describe("type surface", () => {
  it("StreamEvent accepts reasoning-delta", () => {
    const ev: StreamEvent = { type: "reasoning-delta", delta: "thinking" }
    expect(ev.type).toBe("reasoning-delta")
  })
  it("ClineMode accepts auto", () => {
    const m: ClineMode = "auto"
    expect(m).toBe("auto")
  })
})
