export type ProviderMode = "direct" | "openai-compat"

export const DEFAULT_PROVIDER_MODE: ProviderMode = "openai-compat"

export function parseProviderMode(value: string | undefined): ProviderMode {
  if (value === "direct" || value === "openai-compat") return value
  throw new Error(`Unsupported provider mode: ${value ?? "(missing)"}. Expected "direct" or "openai-compat".`)
}

export function resolveProviderMode(mode: ProviderMode | undefined): ProviderMode {
  return mode ?? DEFAULT_PROVIDER_MODE
}
