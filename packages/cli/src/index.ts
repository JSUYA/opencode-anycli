// openclineclicode CLI entry point.
//
// Responsibilities (kept intentionally thin):
//   1. Parse a tiny subset of args (--config, --init, --doctor, --version, --help).
//      Everything else passes through to opencode unchanged.
//   2. Ensure the default config exists (copy from templates/ on first run).
//   3. Verify opencode and cline are on PATH (friendly errors if not).
//   4. Spawn opencode with OPENCODE_CONFIG=<resolved path>, inherit stdio,
//      forward exit code.

import { spawn, spawnSync } from "node:child_process"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolveConfig, defaultConfigPath } from "./config.js"
import { checkOpencode, checkCline } from "./ensure-opencode.js"

const VERSION = "0.1.0"

interface Args {
  config?: string | undefined
  init?: boolean | undefined
  doctor?: boolean | undefined
  version?: boolean | undefined
  help?: boolean | undefined
  passthrough: string[]
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { passthrough: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case "--config":
        out.config = argv[++i]
        break
      case "--init":
        out.init = true
        break
      case "--doctor":
        out.doctor = true
        break
      case "--version":
      case "-V":
        out.version = true
        break
      case "--help":
      case "-h":
        out.help = true
        break
      default:
        out.passthrough.push(a)
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(`openclineclicode v${VERSION}

Run opencode through the locally configured cline CLI.

Usage:
  openclineclicode [flags] [...opencode-args]

Flags:
  --config <path>   Use a specific opencode.json (default: ${defaultConfigPath()})
  --init            (Re)create the default config from the bundled template
  --doctor          Run the diagnostic script and exit
  --version, -V     Print version and exit
  --help, -h        Print this help and exit

Anything not listed above is passed through to opencode unchanged.

Environment:
  OPENCLINECLICODE_CLINE_BIN   Override path to the cline binary
  OPENCLINECLICODE_CONFIG      Override config file path
  DEBUG=1                      Print cline NDJSON events to stderr
`)
}

function runDoctor(): never {
  // Find doctor.sh by walking up from this file.
  const here = dirname(fileURLToPath(import.meta.url))
  let cur = here
  let scriptPath: string | null = null
  for (let i = 0; i < 6; i++) {
    const candidate = pathResolve(cur, "doctor.sh")
    if (existsSync(candidate)) {
      scriptPath = candidate
      break
    }
    cur = dirname(cur)
  }
  if (!scriptPath) {
    process.stderr.write("doctor.sh not found in this checkout. Run from the repo root.\n")
    process.exit(2)
  }
  const r = spawnSync("bash", [scriptPath], { stdio: "inherit" })
  process.exit(r.status ?? 1)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    return
  }
  if (args.version) {
    process.stdout.write(`openclineclicode ${VERSION}\n`)
    return
  }
  if (args.doctor) {
    runDoctor()
  }

  // Pre-flight checks. Fail fast with friendly hints.
  const oc = checkOpencode()
  if (!oc.ok) {
    process.stderr.write(`opencode not available:\n${oc.hint}\n`)
    process.exit(1)
  }
  const cl = checkCline()
  if (!cl.ok) {
    process.stderr.write(`cline not available:\n${cl.hint}\n`)
    process.exit(1)
  }

  // Ensure config file exists.
  const cfg = resolveConfig({ configFlag: args.config, init: args.init })
  if (cfg.created) {
    process.stderr.write(`openclineclicode: created default config at ${cfg.path}\n`)
  }
  if (args.init) {
    process.stdout.write(`Config initialized at ${cfg.path}\n`)
    return
  }

  // Spawn opencode with OPENCODE_CONFIG pointing at our resolved file.
  // Also set XDG_CONFIG_HOME so opencode auto-discovers our wrapper-private
  // commands/agents/skills in ~/.config/openclineclicode/opencode/ instead of
  // the user's primary ~/.config/opencode/. The user can still override by
  // setting XDG_CONFIG_HOME themselves.
  //
  // OPENCODE_DISABLE_MODELS_FETCH=1: opencode normally pulls
  // https://models.dev/api.json on startup and refreshes hourly to populate
  // its model catalog with every public provider (openai, anthropic, etc.).
  // We force-disable that here because:
  //   (a) cline is the ONLY usable provider in this wrapper (single-provider
  //       policy enforced by `enabled_providers: ["cline"]` in the config),
  //   (b) the model picker should not advertise providers the user cannot
  //       reach, and
  //   (c) it removes one external network call from the wrapper's footprint.
  // The user can opt back in by exporting OPENCODE_DISABLE_MODELS_FETCH=0.
  // Inherit stdio so the TUI works.
  const env = {
    ...process.env,
    OPENCODE_CONFIG: cfg.path,
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] || `${homedir()}/.config/openclineclicode`,
    OPENCODE_DISABLE_MODELS_FETCH: process.env["OPENCODE_DISABLE_MODELS_FETCH"] ?? "1",
  }
  const child = spawn("opencode", args.passthrough, { stdio: "inherit", env })
  child.on("close", (code, signal) => {
    if (signal) {
      process.exit(1)
    }
    process.exit(code ?? 0)
  })
  child.on("error", (err) => {
    process.stderr.write(`Failed to spawn opencode: ${err.message}\n`)
    process.exit(1)
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`openclineclicode: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
