// Runtime opencode config materialization.
//
// When the wrapper needs to override or extend the user's resolved
// opencode.json without touching the original file, it composes the
// requested mutations here and writes the result to a single temp file.
// `OPENCODE_CONFIG` is then pointed at that temp path, and the file is
// cleaned up on exit.
//
// Currently the only mutation is auto-approve: mark every documented
// opencode permission as "allow" (top-level + per-agent), so a long-
// running session does not interrupt for every tool call. Existing
// user-set "deny" rules win.
//
// If no mutation is requested or the original config already covers the
// requested behaviour, the function returns null and the caller falls
// back to the original path.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ALL_PERMISSION_KEYS = [
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "bash",
  "task",
  "skill",
  "lsp",
  "question",
  "webfetch",
  "websearch",
  "external_directory",
  "doom_loop",
] as const

export interface TempConfigOptions {
  autoApprove: boolean
}

export interface TempConfigResult {
  path: string
  notes: string[]
}

function allowAllPermissions(): Record<string, "allow"> {
  const out: Record<string, "allow"> = {}
  for (const k of ALL_PERMISSION_KEYS) out[k] = "allow"
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function materializeTempConfig(
  originalPath: string,
  options: TempConfigOptions,
): TempConfigResult | null {
  if (!options.autoApprove) return null

  const original = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>
  // Deep-clone so we never mutate the caller's reference.
  const config = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
  const notes: string[] = []

  const allow = allowAllPermissions()
  const existingTop = isRecord(config["permission"]) ? config["permission"] : {}
  config["permission"] = { ...allow, ...existingTop }
  const existingAgents = isRecord(config["agent"]) ? config["agent"] : {}
  const mergedAgents: Record<string, unknown> = {}
  for (const [name, agent] of Object.entries(existingAgents)) {
    if (!isRecord(agent)) {
      mergedAgents[name] = agent
      continue
    }
    const existing = isRecord(agent["permission"]) ? agent["permission"] : {}
    mergedAgents[name] = { ...agent, permission: { ...allow, ...existing } }
  }
  config["agent"] = mergedAgents
  notes.push("auto-approve: all opencode permissions set to allow")

  const dir = mkdtempSync(join(tmpdir(), "opencode-anycli-cfg-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8")
  return { path, notes }
}

/**
 * Backward-compat shim — kept for any callers that still import the older
 * name. Equivalent to `materializeTempConfig({ autoApprove: true })`.
 */
export function materializeAutoApproveConfig(originalPath: string): string {
  const r = materializeTempConfig(originalPath, { autoApprove: true })
  if (!r) throw new Error("materializeAutoApproveConfig: nothing to mutate")
  return r.path
}
