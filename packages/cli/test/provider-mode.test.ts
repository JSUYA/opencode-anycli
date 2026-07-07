import { describe, expect, it } from "vitest"

import { DEFAULT_PROVIDER_MODE, parseProviderMode, resolveProviderMode } from "../src/provider-mode.js"

describe("provider mode", () => {
  it("defaults to openai-compat", () => {
    expect(DEFAULT_PROVIDER_MODE).toBe("openai-compat")
    expect(resolveProviderMode(undefined)).toBe("openai-compat")
  })

  it("keeps direct as an explicit override", () => {
    expect(parseProviderMode("direct")).toBe("direct")
    expect(resolveProviderMode("direct")).toBe("direct")
  })
})
