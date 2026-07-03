import { describe, it, expect } from "vitest"
import { normalizeClineVersion, buildClineVersionNotice, OPTIMAL_CLINE_VERSION } from "../src/version-notice.js"

describe("normalizeClineVersion", () => {
  it("returns a bare semver as-is", () => {
    expect(normalizeClineVersion("0.5.1")).toBe("0.5.1")
  })
  it("extracts the semver from noisy output", () => {
    expect(normalizeClineVersion("cline version 0.6.0\nnode 22")).toBe("0.6.0")
  })
  it("returns null for null/empty", () => {
    expect(normalizeClineVersion(null)).toBeNull()
    expect(normalizeClineVersion("")).toBeNull()
    expect(normalizeClineVersion(undefined)).toBeNull()
  })
  it("falls back to trimmed text when no semver present", () => {
    expect(normalizeClineVersion("  weird  ")).toBe("weird")
  })
})

describe("buildClineVersionNotice", () => {
  it("shows the optimized ✓ line for 0.5.1", () => {
    const out = buildClineVersionNotice("0.5.1")
    expect(out).toContain(`cline ${OPTIMAL_CLINE_VERSION}`)
    expect(out).toContain("optimized")
    expect(out).toContain("✓")
    expect(out).not.toContain("npm install -g cline")
  })

  it("shows the reinstall guideline for a non-0.5.1 version", () => {
    const out = buildClineVersionNotice("0.6.0")
    expect(out).toContain("optimized for cline 0.5.1")
    expect(out).toContain("Installed cline version: 0.6.0")
    expect(out).toContain("npm uninstall -g cline")
    expect(out).toContain(
      "npm install -g cline@0.5.1 --registry https://bart.sec.samsung.net/artifactory/api/npm/coding-assistant-npm-remote/",
    )
  })

  it("handles unknown version (null) with the guideline", () => {
    const out = buildClineVersionNotice(null)
    expect(out).toContain("Installed cline version: unknown")
    expect(out).toContain("npm install -g cline@0.5.1")
  })
})
