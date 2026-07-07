// opencode config materialization. Optional runtime-only mutations are written
// to a temp file and passed to opencode through OPENCODE_CONFIG.

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
  openAiCompat?: OpenAiCompatTempConfig | undefined
}

export interface OpenAiCompatTempConfig {
  baseURL: string
  apiKey: string
}

export interface TempConfigResult {
  path: string
  notes: string[]
}

function allowAllPermissions(): Record<string, "allow"> {
  const out: Record<string, "allow"> = {}
  for (const key of ALL_PERMISSION_KEYS) out[key] = "allow"
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function materializeTempConfig(originalPath: string, options: TempConfigOptions): TempConfigResult | null {
  if (!options.autoApprove && !options.openAiCompat) return null

  const original = JSON.parse(readFileSync(originalPath, "utf8")) as Record<string, unknown>
  const config = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
  const notes: string[] = []

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
  }

  if (options.openAiCompat) {
    const provider = isRecord(config["provider"]) ? { ...config["provider"] } : {}
    const existingCline = isRecord(provider["cline"]) ? provider["cline"] : {}
    provider["cline"] = {
      ...existingCline,
      npm: "@ai-sdk/openai-compatible",
      name: "Cline (OpenAI-compatible facade)",
      options: {
        baseURL: options.openAiCompat.baseURL,
        apiKey: options.openAiCompat.apiKey,
        includeUsage: true,
      },
    }
    config["provider"] = provider
    notes.push("openai-compat: cline provider routed to local facade")
  }

  const dir = mkdtempSync(join(tmpdir(), "opencode-anycli-cfg-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8")
  return { path, notes }
}

/**
 * Backward-compat shim kept for callers that still import the older name.
 * Equivalent to `materializeTempConfig({ autoApprove: true })`.
 */
export function materializeAutoApproveConfig(originalPath: string): string {
  const r = materializeTempConfig(originalPath, { autoApprove: true })
  if (!r) throw new Error("materializeAutoApproveConfig: nothing to mutate")
  return r.path
}

export default materializeTempConfig
