// Verify that the `opencode` and `cline` binaries are reachable on PATH.
// Print friendly install hints if they're not.

import { spawnSync } from "node:child_process"

export interface BinaryCheck {
  ok: boolean
  version: string | null
  hint: string
}

export function checkOpencode(): BinaryCheck {
  const r = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      version: null,
      hint: [
        "  opencode binary not found on PATH.",
        "  Install: npm install -g opencode-ai",
        "  Or download from: https://github.com/sst/opencode/releases",
      ].join("\n"),
    }
  }
  return { ok: true, version: (r.stdout || r.stderr || "").trim().split("\n")[0] ?? null, hint: "" }
}

export function checkCline(): BinaryCheck {
  const r = spawnSync("cline", ["--version"], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      version: null,
      hint: [
        "  cline binary not found on PATH.",
        "  Install: npm install -g cline",
        "  Then run `cline` once to configure your model and credentials.",
      ].join("\n"),
    }
  }
  return { ok: true, version: (r.stdout || r.stderr || "").trim().split("\n")[0] ?? null, hint: "" }
}
