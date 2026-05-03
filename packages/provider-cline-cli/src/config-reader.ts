// Read the cline config files. Used as a hint for passthrough mode (when implemented)
// and exposed for diagnostics / tests.

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ClineGlobalState {
  actModeApiProvider?: string
  actModeApiModelId?: string
  /** raw object — we don't validate every field. */
  [key: string]: unknown
}

export interface ClineConfigPaths {
  globalState: string
  secrets: string
}

export function defaultClineConfigPaths(home = homedir()): ClineConfigPaths {
  const base = join(home, ".cline", "data")
  return {
    globalState: join(base, "globalState.json"),
    secrets: join(base, "secrets.json"),
  }
}

export function readGlobalState(path?: string): ClineGlobalState | null {
  const p = path ?? defaultClineConfigPaths().globalState
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as ClineGlobalState
  } catch {
    return null
  }
}
