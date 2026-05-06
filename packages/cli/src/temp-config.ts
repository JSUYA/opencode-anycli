// Runtime opencode config materialization.
//
// When the wrapper needs to override or extend the user's resolved
// opencode.json without touching the original file, it composes the
// requested mutations here and writes the result to a single temp file.
// `OPENCODE_CONFIG` is then pointed at that temp path, and the file is
// cleaned up on exit.
//
// Two mutations are currently supported:
//   - auto-approve: mark every documented opencode permission as "allow"
//     (top-level + per-agent), so the long-running session does not
//     interrupt for every tool call. Existing user-set "deny" rules win.
//   - cline-cost: inject `provider.cline.models.<id>.cost` derived from
//     cline's currently-configured provider+model, so opencode's TUI can
//     show a real "$X.XX spent" line. The user's own `cost` block (if any)
//     wins over the injected one.
//
// If no mutation is requested or the original config already covers the
// requested behaviour, the function returns null and the caller falls back
// to the original path.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupClineCost, ratesToConfigCost, type PricingMatch } from "./cline-pricing.js"

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
  /** cline's currently-configured provider+model, if known. */
  clineModel: { providerId?: string | null; modelId?: string | null } | null
}

export interface TempConfigResult {
  path: string
  notes: string[]
  /** Diagnostic detail for cost injection (null if not injected). */
  pricing: PricingMatch | null
}

function allowAllPermissions(): Record<string, "allow"> {
  const out: Record<string, "allow"> = {}
  for (const k of ALL_PERMISSION_KEYS) out[k] = "allow"
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Walk `provider.cline.models` and inject `cost` on entries that don't have
 * one yet. Returns the mutated config and the matched pricing entry, or
 * null if no models were touched.
 */
function applyClineCost(
  config: Record<string, unknown>,
  pricing: PricingMatch,
): { mutated: boolean; pricing: PricingMatch } {
  const provider = isRecord(config["provider"]) ? config["provider"] : null
  if (!provider) return { mutated: false, pricing }
  const cline = isRecord(provider["cline"]) ? provider["cline"] : null
  if (!cline) return { mutated: false, pricing }
  const models = isRecord(cline["models"]) ? cline["models"] : null
  if (!models) return { mutated: false, pricing }

  let mutated = false
  for (const [name, entry] of Object.entries(models)) {
    if (!isRecord(entry)) continue
    if ("cost" in entry) continue // user-supplied cost wins
    entry["cost"] = ratesToConfigCost(pricing.rates)
    mutated = true
    void name
  }
  return { mutated, pricing }
}

export function materializeTempConfig(
  originalPath: string,
  options: TempConfigOptions,
): TempConfigResult | null {
  const original = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>
  // Deep-clone so we never mutate the caller's reference.
  const config = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
  const notes: string[] = []
  let mutated = false

  if (options.autoApprove) {
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
    mutated = true
  }

  let pricing: PricingMatch | null = null
  if (options.clineModel) {
    pricing = lookupClineCost({
      providerId: options.clineModel.providerId ?? undefined,
      modelId: options.clineModel.modelId ?? undefined,
    })
    if (pricing) {
      const { mutated: costMutated } = applyClineCost(config, pricing)
      if (costMutated) {
        notes.push(
          `cline cost: ${pricing.matchedKey} → input $${pricing.rates.input}/1M, output $${pricing.rates.output}/1M`,
        )
        mutated = true
      }
    }
  }

  if (!mutated) return null

  const dir = mkdtempSync(join(tmpdir(), "opencode-anycli-cfg-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8")
  return { path, notes, pricing }
}

/**
 * Backward-compat shim — kept for any callers that still import the older
 * name. Equivalent to `materializeTempConfig({ autoApprove: true, … })`.
 */
export function materializeAutoApproveConfig(originalPath: string): string {
  const r = materializeTempConfig(originalPath, { autoApprove: true, clineModel: null })
  if (!r) throw new Error("materializeAutoApproveConfig: nothing to mutate")
  return r.path
}
