import { describe, it, expect } from "vitest"
import { lookupClineCost, ratesToConfigCost } from "../src/cline-pricing.js"

describe("lookupClineCost", () => {
  it("matches Anthropic provider + claude-opus-4 model", () => {
    const m = lookupClineCost({ providerId: "anthropic", modelId: "claude-opus-4-20250514" })
    expect(m).not.toBeNull()
    expect(m!.family).toBe("anthropic")
    expect(m!.matchedKey).toBe("anthropic/claude-opus-4")
    expect(m!.rates.input).toBe(15)
    expect(m!.rates.output).toBe(75)
    expect(m!.rates.cache?.read).toBe(1.5)
    expect(m!.rates.cache?.write).toBe(18.75)
  })

  it("matches openai-codex provider + gpt-5.5 model with no rates → null", () => {
    expect(lookupClineCost({ providerId: "openai-codex", modelId: "gpt-5.5" })).toBeNull()
  })

  it("matches openai-codex provider + gpt-4o", () => {
    const m = lookupClineCost({ providerId: "openai-codex", modelId: "gpt-4o-2024-08-06" })
    expect(m).not.toBeNull()
    expect(m!.family).toBe("openai")
    expect(m!.matchedKey).toBe("openai/gpt-4o")
  })

  it("matches gpt-4o-mini before gpt-4o (specific wins)", () => {
    const m = lookupClineCost({ providerId: "openai", modelId: "gpt-4o-mini" })
    expect(m!.matchedKey).toBe("openai/gpt-4o-mini")
    expect(m!.rates.input).toBe(0.15)
  })

  it("matches openrouter routes to anthropic via modelId substring", () => {
    const m = lookupClineCost({ providerId: "openrouter", modelId: "anthropic/claude-3-5-sonnet-20241022" })
    expect(m).not.toBeNull()
    expect(m!.family).toBe("anthropic")
    expect(m!.matchedKey).toBe("anthropic/claude-3-5-sonnet")
  })

  it("matches openrouter google route", () => {
    const m = lookupClineCost({ providerId: "openrouter", modelId: "google/gemini-2.5-pro" })
    expect(m!.family).toBe("google")
  })

  it("matches gemini provider + gemini-2.5-flash", () => {
    const m = lookupClineCost({ providerId: "gemini", modelId: "gemini-2.5-flash-preview" })
    expect(m!.matchedKey).toBe("google/gemini-2.5-flash")
    expect(m!.rates.input).toBe(0.3)
  })

  it("returns null when providerId is unknown and modelId matches nothing", () => {
    expect(lookupClineCost({ providerId: "fake-provider", modelId: "fake-model" })).toBeNull()
  })

  it("returns null on empty/missing input", () => {
    expect(lookupClineCost({})).toBeNull()
    expect(lookupClineCost({ providerId: "anthropic" })).toBeNull()
    expect(lookupClineCost({ providerId: "anthropic", modelId: "" })).toBeNull()
  })

  it("falls through provider mismatch but matches model substring", () => {
    // unknown provider, but the model name itself reveals the vendor
    const m = lookupClineCost({ providerId: "unknown-provider", modelId: "claude-3-5-sonnet" })
    expect(m).not.toBeNull()
    expect(m!.family).toBe("anthropic")
  })

  it("matches deepseek-reasoner correctly", () => {
    const m = lookupClineCost({ providerId: "deepseek", modelId: "deepseek-reasoner" })
    expect(m!.matchedKey).toBe("deepseek/deepseek-reasoner")
    expect(m!.rates.cache?.read).toBe(0.14)
  })
})

describe("ratesToConfigCost", () => {
  it("emits cache block when cache rates present", () => {
    const c = ratesToConfigCost({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })
    expect(c).toEqual({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })
  })

  it("omits cache block when cache absent", () => {
    const c = ratesToConfigCost({ input: 30, output: 60 })
    expect(c).toEqual({ input: 30, output: 60 })
    expect("cache" in c).toBe(false)
  })

  it("emits partial cache block (read only)", () => {
    const c = ratesToConfigCost({ input: 1, output: 2, cache: { read: 0.5 } })
    expect(c).toEqual({ input: 1, output: 2, cache: { read: 0.5 } })
  })
})
