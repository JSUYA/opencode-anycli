// Resolve the path to the opencode.json that this CLI will hand to opencode.
//
// Precedence:
//   1. --config <path> CLI flag
//   2. OPENCLINECLICODE_CONFIG env var
//   3. ~/.config/openclineclicode/opencode/opencode.json (default)
//
// The default lives under ~/.config/openclineclicode/opencode/ — one level
// deeper than the wrapper's XDG dir — so opencode reads it automatically when
// the CLI launches it with XDG_CONFIG_HOME=~/.config/openclineclicode.
//
// Also handles --init: copies templates/opencode.json into the default location.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface ResolvedConfig {
  /** Absolute path to the opencode.json that will be used. */
  path: string
  /** True if we just created the file as part of this resolve call. */
  created: boolean
}

export function defaultConfigPath(home = homedir()): string {
  return join(home, ".config", "openclineclicode", "opencode", "opencode.json")
}

export function resolveConfig(args: { configFlag?: string | undefined; init?: boolean | undefined }): ResolvedConfig {
  const fromFlag = args.configFlag ? resolve(args.configFlag) : undefined
  const fromEnv = process.env["OPENCLINECLICODE_CONFIG"]
  const target = fromFlag ?? fromEnv ?? defaultConfigPath()

  if (args.init || !existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    const { templatePath, providerDist } = locateRepoArtifacts()
    // Substitute the placeholder so opencode loads the local provider build
    // via file:// (instead of trying to npm-install the un-published package).
    // install.sh does the same substitution; we mirror that logic so the CLI's
    // first-run auto-create produces an immediately-usable config.
    const tpl = readFileSync(templatePath, "utf8")
    const resolved = tpl.replace(/__OPENCLINECLICODE_PROVIDER_DIST__/g, providerDist)
    writeFileSync(target, resolved, "utf8")
    return { path: target, created: true }
  }
  return { path: target, created: false }
}

/**
 * Locate templates/opencode.json AND the built provider dist
 * (packages/provider-cline-cli/dist/index.js) by walking up from this file.
 * Both must exist for the auto-created config to actually work.
 */
function locateRepoArtifacts(): { templatePath: string; providerDist: string } {
  const here = dirname(fileURLToPath(import.meta.url))
  let cur = here
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, "templates", "opencode.json")
    if (existsSync(candidate)) {
      const providerDist = join(cur, "packages", "provider-cline-cli", "dist", "index.js")
      if (!existsSync(providerDist)) {
        throw new Error(
          `Found template at ${candidate} but provider dist is missing at ${providerDist}. ` +
            `Run \`npm run build --workspaces\` (or \`./install.sh\`) to build the provider first.`,
        )
      }
      return { templatePath: candidate, providerDist }
    }
    cur = dirname(cur)
  }
  throw new Error(
    `Could not locate templates/opencode.json. Tried walking up from ${here}. ` +
      `Make sure you are running openclineclicode from a checkout of the repository.`,
  )
}

/** Sanity-check that the config file is valid JSON. Returns the parsed object or throws. */
export function readConfig(path: string): unknown {
  const raw = readFileSync(path, "utf8")
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Failed to parse ${path} as JSON: ${(err as Error).message}`)
  }
}
