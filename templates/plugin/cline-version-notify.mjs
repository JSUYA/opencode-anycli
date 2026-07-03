// opencode-anycli — cline version TUI notification.
//
// Surfaces the installed cline version as a toast when an opencode session
// starts, so the user can see at a glance whether they're on the ACP-optimized
// build (0.5.1) or a subprocess-fallback build. Best-effort: the toast is only
// visible in the interactive TUI; headless `run` sessions have no TUI and the
// call is a harmless no-op.
//
// Loaded either by opencode auto-discovery (it lives under the config
// `plugin/` dir) or via an explicit `plugin` config entry.

import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const OPTIMAL_CLINE_VERSION = "0.5.1"

function debugLog(line) {
  try {
    const p = join(homedir(), ".cache", "opencode-anycli", "version-notify.log")
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* logging must never break the plugin */
  }
}

/** Detect the installed cline version (bare semver), or null. */
function detectClineVersion() {
  const bin = process.env["OPENCODE_ANYCLI_CLINE_BIN"] || "cline"
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" })
    if (r.status !== 0) return null
    const line = (r.stdout || r.stderr || "").trim().split("\n")[0] || ""
    const m = line.match(/\d+\.\d+\.\d+/)
    return m ? m[0] : line || null
  } catch {
    return null
  }
}

export const ClineVersionNotify = async ({ client }) => {
  const version = detectClineVersion()
  debugLog(`plugin loaded — detected cline version: ${version ?? "unknown"}`)

  const optimal = version === OPTIMAL_CLINE_VERSION
  const message = version
    ? optimal
      ? `cline ${version} · ACP 최적화 활성`
      : `cline ${version} · 권장 ${OPTIMAL_CLINE_VERSION} 아님 (subprocess 모드) — 종료 후 안내 참고`
    : `cline 버전 감지 실패`
  const variant = version ? (optimal ? "success" : "warning") : "warning"

  let shown = false
  const showOnce = async () => {
    if (shown) return
    shown = true
    try {
      await client.tui.showToast({ title: "opencode-anycli", message, variant })
      debugLog(`toast shown: variant=${variant} message="${message}"`)
    } catch (err) {
      debugLog(`toast failed (no TUI attached?): ${String(err)}`)
    }
  }

  // Fire on the first server event (the TUI is attached by then). A short
  // timer is a fallback in case events are quiet at startup; both are guarded
  // by `shown` so the toast appears at most once.
  const timer = setTimeout(() => {
    void showOnce()
  }, 1500)
  if (typeof timer.unref === "function") timer.unref()

  return {
    event: async () => {
      await showOnce()
    },
  }
}

export default ClineVersionNotify
