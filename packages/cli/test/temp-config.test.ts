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
  it("returns null when autoApprove is false (no mutation requested)", () => {
    const { path, cleanup } = withOriginal({ permission: {}, agent: {} })
    try {
      expect(materializeTempConfig(path, { autoApprove: false })).toBeNull()
    } finally { cleanup() }
  })

  it("applies auto-approve permissions at top level and per agent", () => {
    const { path, cleanup } = withOriginal({
      provider: { cline: { models: { default: {} } } },
      agent: { build: { model: "cline/default" } },
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: true })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.permission["bash"]).toBe("allow")
      expect(written.permission["edit"]).toBe("allow")
      expect(written.agent.build.permission["bash"]).toBe("allow")
      expect(r!.notes.some((n) => n.includes("auto-approve"))).toBe(true)
      rmSync(r!.path, { force: true })
    } finally { cleanup() }
  })

  it("preserves user 'deny' permission overrides on top of auto-approve", () => {
    const { path, cleanup } = withOriginal({
      permission: { bash: "deny" },
      agent: {},
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: true })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.permission["bash"]).toBe("deny")
      expect(written.permission["read"]).toBe("allow")
      rmSync(r!.path, { force: true })
    } finally { cleanup() }
  })
})
