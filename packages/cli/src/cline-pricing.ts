// Per-1M-token cost rates for the cline providers/models we know about.
//
// Why this file exists:
//   opencode's TUI shows "$0.00 spent" whenever the active model has no
//   `cost` block in its config. cline reports `cost: 0` to us in most setups,
//   so unless we populate the model.cost ourselves the cost line is always
//   zero. This module gives the wrapper a static pricing table keyed on
//   (cline providerId, modelId substring) so it can inject `cost: { … }`
//   into a runtime temp config that opencode reads.
//
// Coverage and freshness:
//   The rates below were captured against published vendor pricing as of
//   2026-05. They drift over time. Users who want exact figures can override
//   by editing `~/.config/opencode-anycli/opencode/opencode.json` directly:
//   any explicit `provider.cline.models.<id>.cost` set there wins over what
//   we inject (the wrapper merges, but the user's value comes last).

export interface CostRates {
  /** USD per 1M non-cached input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /** Optional cache pricing (per 1M tokens). */
  cache?: {
    read?: number
    write?: number
  }
}

export interface PricingMatch {
  rates: CostRates
  /** Human-readable label of the price-table entry that matched. */
  matchedKey: string
  /** Family the rates came from — useful for diagnostics. */
  family: "anthropic" | "openai" | "google" | "deepseek" | "xai" | "mistral"
}

interface ModelEntry {
  /** Substring (case-insensitive) the cline modelId must contain. */
  contains: string
  rates: CostRates
}

/** Anthropic Claude models (per vendor pricing). */
const ANTHROPIC: ModelEntry[] = [
  { contains: "claude-opus-4", rates: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } } },
  { contains: "claude-sonnet-4", rates: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
  { contains: "claude-haiku-4", rates: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } } },
  { contains: "claude-3-7-sonnet", rates: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
  { contains: "claude-3-5-sonnet", rates: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
  { contains: "claude-3-5-haiku", rates: { input: 0.8, output: 4, cache: { read: 0.08, write: 1 } } },
  { contains: "claude-3-opus", rates: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } } },
  { contains: "claude-3-sonnet", rates: { input: 3, output: 15 } },
  { contains: "claude-3-haiku", rates: { input: 0.25, output: 1.25, cache: { read: 0.03, write: 0.3 } } },
]

/** OpenAI (and openai-codex) chat / reasoning models. */
const OPENAI: ModelEntry[] = [
  { contains: "gpt-4o-mini", rates: { input: 0.15, output: 0.6, cache: { read: 0.075 } } },
  { contains: "gpt-4o", rates: { input: 2.5, output: 10, cache: { read: 1.25 } } },
  { contains: "gpt-4-turbo", rates: { input: 10, output: 30 } },
  { contains: "gpt-4.1-mini", rates: { input: 0.4, output: 1.6, cache: { read: 0.1 } } },
  { contains: "gpt-4.1-nano", rates: { input: 0.1, output: 0.4, cache: { read: 0.025 } } },
  { contains: "gpt-4.1", rates: { input: 2, output: 8, cache: { read: 0.5 } } },
  { contains: "gpt-4", rates: { input: 30, output: 60 } },
  { contains: "gpt-3.5", rates: { input: 0.5, output: 1.5 } },
  { contains: "o4-mini", rates: { input: 1.1, output: 4.4, cache: { read: 0.275 } } },
  { contains: "o3-mini", rates: { input: 1.1, output: 4.4, cache: { read: 0.55 } } },
  { contains: "o3", rates: { input: 2, output: 8, cache: { read: 0.5 } } },
  { contains: "o1-preview", rates: { input: 15, output: 60, cache: { read: 7.5 } } },
  { contains: "o1-mini", rates: { input: 3, output: 12, cache: { read: 1.5 } } },
  { contains: "o1", rates: { input: 15, output: 60, cache: { read: 7.5 } } },
]

/** Google Gemini models. */
const GOOGLE: ModelEntry[] = [
  { contains: "gemini-2.5-pro", rates: { input: 1.25, output: 10, cache: { read: 0.31 } } },
  { contains: "gemini-2.5-flash", rates: { input: 0.3, output: 2.5, cache: { read: 0.075 } } },
  { contains: "gemini-2.0-flash-lite", rates: { input: 0.075, output: 0.3 } },
  { contains: "gemini-2.0-flash", rates: { input: 0.1, output: 0.4, cache: { read: 0.025 } } },
  { contains: "gemini-1.5-pro", rates: { input: 1.25, output: 5, cache: { read: 0.3125 } } },
  { contains: "gemini-1.5-flash", rates: { input: 0.075, output: 0.3, cache: { read: 0.01875 } } },
]

/** DeepSeek (cline supports it as a separate provider). */
const DEEPSEEK: ModelEntry[] = [
  { contains: "deepseek-reasoner", rates: { input: 0.55, output: 2.19, cache: { read: 0.14 } } },
  { contains: "deepseek-chat", rates: { input: 0.27, output: 1.1, cache: { read: 0.07 } } },
  { contains: "deepseek-coder", rates: { input: 0.14, output: 0.28 } },
]

/** xAI Grok models. */
const XAI: ModelEntry[] = [
  { contains: "grok-2", rates: { input: 2, output: 10 } },
  { contains: "grok-3-mini", rates: { input: 0.3, output: 0.5 } },
  { contains: "grok-3", rates: { input: 3, output: 15 } },
  { contains: "grok-4", rates: { input: 5, output: 25 } },
]

/** Mistral models. */
const MISTRAL: ModelEntry[] = [
  { contains: "mistral-large", rates: { input: 2, output: 6 } },
  { contains: "mistral-medium", rates: { input: 2.7, output: 8.1 } },
  { contains: "mistral-small", rates: { input: 0.2, output: 0.6 } },
  { contains: "codestral", rates: { input: 0.3, output: 0.9 } },
]

/**
 * Provider buckets, ordered. Each bucket attaches a "family" label and a
 * fallback table to consult when the cline providerId narrows us down to a
 * vendor but we don't recognise the specific model.
 */
const PROVIDER_TABLES: ReadonlyArray<{
  family: PricingMatch["family"]
  /** Matches when cline's `actModeApiProvider` equals or starts with this. */
  providerPrefixes: readonly string[]
  models: readonly ModelEntry[]
}> = [
  { family: "anthropic", providerPrefixes: ["anthropic"], models: ANTHROPIC },
  { family: "openai", providerPrefixes: ["openai", "openai-native", "openai-codex", "azure"], models: OPENAI },
  { family: "google", providerPrefixes: ["gemini", "google", "vertex"], models: GOOGLE },
  { family: "deepseek", providerPrefixes: ["deepseek"], models: DEEPSEEK },
  { family: "xai", providerPrefixes: ["xai", "grok"], models: XAI },
  { family: "mistral", providerPrefixes: ["mistral", "codestral"], models: MISTRAL },
]

/**
 * Some cline providers (openrouter, requesty, bedrock, vertex, custom
 * openai-compatible) route to multiple vendors. For those we ignore
 * providerId and match on modelId substring across every table.
 */
const PROVIDER_PROXIES = new Set([
  "openrouter",
  "requesty",
  "bedrock",
  "vertex",
  "openai-compatible",
  "litellm",
  "cline",
])

const ALL_FAMILIES: ReadonlyArray<{ family: PricingMatch["family"]; models: readonly ModelEntry[] }> =
  PROVIDER_TABLES.map((t) => ({ family: t.family, models: t.models }))

export function lookupClineCost(input: {
  providerId?: string | null | undefined
  modelId?: string | null | undefined
}): PricingMatch | null {
  const provider = (input.providerId ?? "").toLowerCase().trim()
  const model = (input.modelId ?? "").toLowerCase().trim()
  if (model === "") return null

  // 1. Provider-anchored lookup.
  const bucket = PROVIDER_TABLES.find((t) => t.providerPrefixes.some((p) => provider === p || provider.startsWith(p + "-") || provider.startsWith(p + "/")))
  if (bucket) {
    const hit = bucket.models.find((m) => model.includes(m.contains))
    if (hit) return { rates: hit.rates, matchedKey: `${bucket.family}/${hit.contains}`, family: bucket.family }
    // Fall through to cross-family matching — provider hint matched but the
    // specific model didn't, so the user might be on a non-listed variant.
  }

  // 2. Multi-vendor proxy (openrouter, bedrock, …) — try every family.
  if (PROVIDER_PROXIES.has(provider) || bucket === undefined) {
    for (const t of ALL_FAMILIES) {
      const hit = t.models.find((m) => model.includes(m.contains))
      if (hit) return { rates: hit.rates, matchedKey: `${t.family}/${hit.contains}`, family: t.family }
    }
  }

  return null
}

/**
 * Convert {@link CostRates} to the JSON shape opencode expects under
 * `provider.<id>.models.<id>.cost`. Keeps the cache block out when there's
 * no cache info, since opencode treats absence as "0 cache cost" anyway.
 */
export function ratesToConfigCost(rates: CostRates): Record<string, unknown> {
  const out: Record<string, unknown> = { input: rates.input, output: rates.output }
  if (rates.cache && (rates.cache.read !== undefined || rates.cache.write !== undefined)) {
    const cache: Record<string, number> = {}
    if (rates.cache.read !== undefined) cache["read"] = rates.cache.read
    if (rates.cache.write !== undefined) cache["write"] = rates.cache.write
    out["cache"] = cache
  }
  return out
}
