import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { materializeTempConfig } from "../src/temp-config.js"

function withOriginal(content: object): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "occ-tc-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, JSON.stringify(content))
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("materializeTempConfig", () => {
  it("returns null when nothing changes", () => {
    const { path, cleanup } = withOriginal({
      provider: { cline: { models: { default: {} } } },
    })
    try {
      // No autoApprove, unknown model → no mutation.
      const r = materializeTempConfig(path, { autoApprove: false, clineModel: { providerId: "fake", modelId: "no-such" } })
      expect(r).toBeNull()
    } finally { cleanup() }
  })

  it("injects cost block for matching cline model", () => {
    const { path, cleanup } = withOriginal({
      provider: { cline: { models: { default: { name: "Cline default" } } } },
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: false, clineModel: { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" } })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as { provider: { cline: { models: { default: { cost?: unknown } } } } }
      expect(written.provider.cline.models.default.cost).toEqual({
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      })
      expect(r!.pricing?.matchedKey).toBe("anthropic/claude-sonnet-4")
      expect(r!.notes.some((n) => n.includes("anthropic/claude-sonnet-4"))).toBe(true)
      rmSync(r!.path, { force: true })
    } finally { cleanup() }
  })

  it("does not overwrite existing cost block (user wins)", () => {
    const { path, cleanup } = withOriginal({
      provider: { cline: { models: { default: { cost: { input: 99, output: 999 } } } } },
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: false, clineModel: { providerId: "anthropic", modelId: "claude-opus-4" } })
      expect(r).toBeNull()
    } finally { cleanup() }
  })

  it("applies auto-approve permissions on top + cost together", () => {
    const { path, cleanup } = withOriginal({
      provider: { cline: { models: { default: {} } } },
      agent: { build: { model: "cline/default" } },
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: true, clineModel: { providerId: "openai", modelId: "gpt-4o" } })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.permission["bash"]).toBe("allow")
      expect(written.agent.build.permission["bash"]).toBe("allow")
      expect(written.provider.cline.models.default.cost.input).toBe(2.5)
      rmSync(r!.path, { force: true })
    } finally { cleanup() }
  })

  it("preserves user 'deny' permission overrides on top of auto-approve", () => {
    const { path, cleanup } = withOriginal({
      permission: { bash: "deny" },
      provider: { cline: { models: { default: {} } } },
      agent: {},
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: true, clineModel: null })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.permission["bash"]).toBe("deny")
      expect(written.permission["read"]).toBe("allow")
      rmSync(r!.path, { force: true })
    } finally { cleanup() }
  })
})
