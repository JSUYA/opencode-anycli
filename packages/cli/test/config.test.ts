import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { defaultConfigPath, resolveConfig, readConfig } from "../src/config.js"

describe("defaultConfigPath", () => {
  it("returns ~/.config/opencode-anycli/opencode/opencode.json by default", () => {
    expect(defaultConfigPath()).toBe(join(homedir(), ".config", "opencode-anycli", "opencode", "opencode.json"))
  })

  it("honors a custom home dir", () => {
    expect(defaultConfigPath("/fake/home")).toBe("/fake/home/.config/opencode-anycli/opencode/opencode.json")
  })
})

describe("resolveConfig", () => {
  let tmp: string
  let envBackup: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "occ-cfg-"))
    envBackup = process.env["OPENCODE_ANYCLI_CONFIG"]
    delete process.env["OPENCODE_ANYCLI_CONFIG"]
  })

  afterEach(() => {
    if (envBackup === undefined) delete process.env["OPENCODE_ANYCLI_CONFIG"]
    else process.env["OPENCODE_ANYCLI_CONFIG"] = envBackup
    rmSync(tmp, { recursive: true, force: true })
  })

  it("uses --config flag when provided", () => {
    const target = join(tmp, "custom.json")
    writeFileSync(target, '{"$schema":"https://opencode.ai/config.json"}')
    const r = resolveConfig({ configFlag: target })
    expect(r.path).toBe(target)
    expect(r.created).toBe(false)
  })

  it("OPENCODE_ANYCLI_CONFIG env wins over default", () => {
    const target = join(tmp, "env.json")
    writeFileSync(target, '{"$schema":"https://opencode.ai/config.json"}')
    process.env["OPENCODE_ANYCLI_CONFIG"] = target
    const r = resolveConfig({})
    expect(r.path).toBe(target)
    expect(r.created).toBe(false)
  })

  it("--config flag wins over OPENCODE_ANYCLI_CONFIG env", () => {
    const flagTarget = join(tmp, "flag.json")
    const envTarget = join(tmp, "env.json")
    writeFileSync(flagTarget, "{}")
    writeFileSync(envTarget, "{}")
    process.env["OPENCODE_ANYCLI_CONFIG"] = envTarget
    const r = resolveConfig({ configFlag: flagTarget })
    expect(r.path).toBe(flagTarget)
  })
})

describe("readConfig", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "occ-read-"))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it("parses valid JSON", () => {
    const p = join(tmp, "ok.json")
    writeFileSync(p, '{"model":"cline/default"}')
    const obj = readConfig(p) as { model: string }
    expect(obj.model).toBe("cline/default")
  })

  it("throws a helpful error on invalid JSON", () => {
    const p = join(tmp, "bad.json")
    writeFileSync(p, "{not json")
    expect(() => readConfig(p)).toThrow(/Failed to parse/)
  })
})

describe("config integration with templates", () => {
  it("can locate the bundled template (smoke test — file system)", () => {
    // Verify the templates/ directory exists at a discoverable location
    // relative to the build output.
    const here = join(__dirname, "..")
    const candidates = [
      join(here, "..", "..", "templates", "opencode.json"),
      join(here, "..", "..", "..", "templates", "opencode.json"),
    ]
    const found = candidates.some((p) => existsSync(p))
    expect(found).toBe(true)

    // The template must contain the placeholder that install.sh substitutes.
    for (const c of candidates) {
      if (existsSync(c)) {
        const content = readFileSync(c, "utf8")
        expect(content).toContain("__OPENCODE_ANYCLI_PROVIDER_DIST__")
        return
      }
    }
  })
})

describe("config sanity — installed path", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "occ-init-"))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it("resolveConfig with non-existent target file does NOT auto-create when configFlag points elsewhere", () => {
    // When --config points at an existing file, do not touch the default location.
    const target = join(tmp, "explicit.json")
    writeFileSync(target, "{}")
    const r = resolveConfig({ configFlag: target })
    expect(r.created).toBe(false)
  })

  it("resolveConfig with --init=true substitutes the provider-dist placeholder when copying the template", () => {
    // Use a fresh path so init has to copy the template.
    const target = join(tmp, "init.json")
    mkdirSync(tmp, { recursive: true })
    const r = resolveConfig({ configFlag: target, init: true })
    expect(r.created).toBe(true)
    expect(existsSync(target)).toBe(true)
    const content = readFileSync(target, "utf8")
    // The CLI must substitute __OPENCODE_ANYCLI_PROVIDER_DIST__ → absolute
    // file:// path to the built provider, otherwise opencode hits ProviderInitError.
    expect(content).not.toContain("__OPENCODE_ANYCLI_PROVIDER_DIST__")
    expect(content).toMatch(/file:\/\/.*\/provider-cline-cli\/dist\/index\.js/)
    // Sanity-check the surrounding JSON shape is intact.
    const parsed = JSON.parse(content) as { provider: { cline: { npm: string } } }
    expect(parsed.provider.cline.npm).toMatch(/^file:\/\/\//)
  })
})
