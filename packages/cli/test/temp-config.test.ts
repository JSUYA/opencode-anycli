import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import materializeTempConfig from "../src/temp-config.js"

function withOriginal(content: object): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "occ-tc-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, JSON.stringify(content), "utf8")
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("materializeTempConfig", () => {
  it("returns null when no mutation is requested", () => {
    const { path, cleanup } = withOriginal({ agent: {} })
    try {
      expect(materializeTempConfig(path, { autoApprove: false })).toBeNull()
    } finally {
      cleanup()
    }
  })

  it("materializes auto-approve permissions", () => {
    const { path, cleanup } = withOriginal({
      permission: { bash: "deny" },
      agent: { build: { permission: { bash: "deny" } } },
    })
    try {
      const r = materializeTempConfig(path, { autoApprove: true })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.permission["bash"]).toBe("deny")
      expect(written.permission["edit"]).toBe("allow")
      expect(written.agent.build.permission["bash"]).toBe("deny")
      expect(written.agent.build.permission["edit"]).toBe("allow")
      expect(r!.notes.some((n) => n.includes("auto-approve"))).toBe(true)
      rmSync(r!.path, { force: true })
    } finally {
      cleanup()
    }
  })

  it("materializes openai-compatible cline provider without changing model references", () => {
    const { path, cleanup } = withOriginal({
      provider: {
        cline: {
          npm: "file:///tmp/provider.js",
          name: "Cline",
          models: { "GaussO4.1-CLI": { name: "Cline GaussO4.1-CLI" } },
          options: { cli: "cline", mode: "auto" },
        },
      },
      model: "cline/GaussO4.1-CLI",
    })
    try {
      const r = materializeTempConfig(path, {
        autoApprove: false,
        openAiCompat: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "token" },
      })
      expect(r).not.toBeNull()
      const written = JSON.parse(readFileSync(r!.path, "utf8")) as Record<string, any>
      expect(written.provider.cline.npm).toBe("@ai-sdk/openai-compatible")
      expect(written.provider.cline.options.baseURL).toBe("http://127.0.0.1:1234/v1")
      expect(written.provider.cline.options.apiKey).toBe("token")
      expect(written.provider.cline.models["GaussO4.1-CLI"]).toBeDefined()
      expect(written.model).toBe("cline/GaussO4.1-CLI")
      expect(r!.notes.some((n) => n.includes("openai-compat"))).toBe(true)
      rmSync(r!.path, { force: true })
    } finally {
      cleanup()
    }
  })
})
