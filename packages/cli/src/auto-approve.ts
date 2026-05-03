// Auto-approve config materialization.
//
// opencode's permission system is config-driven (per-agent or top-level).
// There is no documented runtime toggle and no env var that disables prompts
// wholesale. So when the user passes --auto-approve to our wrapper, we
// materialize a temp config that explicitly sets every known permission
// type to "allow" (both top-level and on each declared agent), point
// OPENCODE_CONFIG at it for the spawned session, and clean up on exit.
//
// To extend: when opencode adds new permission keys, append them to
// ALL_PERMISSION_KEYS below. The catch-all "*": "allow" should cover
// future additions, but explicit keys defend against opencode keeping
// per-key defaults of "ask" (which the docs note for doom_loop and
// external_directory).

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

function allowAllPermissions(): Record<string, "allow"> {
  const out: Record<string, "allow"> = {}
  for (const k of ALL_PERMISSION_KEYS) out[k] = "allow"
  return out
}

/**
 * Read the user's resolved opencode.json, deep-merge "allow all" permissions
 * into the top level AND each declared agent, write the result to a temp
 * file, and return the temp file path. Caller is responsible for setting
 * OPENCODE_CONFIG to the returned path and cleaning up on exit.
 */
export function materializeAutoApproveConfig(originalPath: string): string {
  const original = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>

  const allow = allowAllPermissions()

  // Top-level permission. Existing user-set values win (so a user who
  // explicitly set `permission: { bash: "deny" }` is respected even with
  // --auto-approve — they have to opt out of their own deny rule first).
  const existingTop = (original["permission"] as Record<string, unknown> | undefined) ?? {}
  const mergedTop: Record<string, unknown> = { ...allow, ...existingTop }

  // Per-agent permissions for every declared agent.
  const existingAgents = (original["agent"] as Record<string, Record<string, unknown>> | undefined) ?? {}
  const mergedAgents: Record<string, Record<string, unknown>> = {}
  for (const [name, agent] of Object.entries(existingAgents)) {
    const existing = (agent["permission"] as Record<string, unknown> | undefined) ?? {}
    mergedAgents[name] = { ...agent, permission: { ...allow, ...existing } }
  }

  const merged = { ...original, permission: mergedTop, agent: mergedAgents }

  const dir = mkdtempSync(join(tmpdir(), "opencode-anycli-autoapprove-"))
  const tmpPath = join(dir, "opencode.json")
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8")
  return tmpPath
}
