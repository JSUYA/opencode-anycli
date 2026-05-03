// opencode-anycli CLI entry point.
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
import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { resolveConfig, defaultConfigPath } from "./config.js"
import { checkOpencode, checkCline } from "./ensure-opencode.js"
import { materializeAutoApproveConfig } from "./auto-approve.js"

const VERSION = "0.1.0"

interface Args {
  config?: string | undefined
  init?: boolean | undefined
  doctor?: boolean | undefined
  update?: boolean | undefined
  setupSudo?: boolean | undefined
  version?: boolean | undefined
  help?: boolean | undefined
  autoApprove?: boolean | undefined
  noTty?: boolean | undefined
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
      case "--update":
        // Everything AFTER --update is forwarded to install.sh as-is, so the
        // user can run `opencode-anycli --update --user --skip-build` etc.
        out.update = true
        out.passthrough.push(...argv.slice(i + 1))
        i = argv.length
        break
      case "--setup-sudo":
        // Anything after --setup-sudo is forwarded to setup-sudo.sh
        // (e.g. --yes, --remove, --print).
        out.setupSudo = true
        out.passthrough.push(...argv.slice(i + 1))
        i = argv.length
        break
      case "--version":
      case "-V":
        out.version = true
        break
      case "--help":
      case "-h":
        out.help = true
        break
      case "--auto-approve":
      case "--yolo":
      case "-y":
        out.autoApprove = true
        break
      case "--tty":
        // Backwards-compat: TTY is now ON by default. Accepting --tty
        // remains a no-op so existing scripts don't break.
        break
      case "--no-tty":
        out.noTty = true
        break
      default:
        out.passthrough.push(a)
    }
  }
  // OPENCODE_ANYCLI_AUTO_APPROVE=1 is equivalent to --auto-approve.
  if (process.env["OPENCODE_ANYCLI_AUTO_APPROVE"] === "1") {
    out.autoApprove = true
  }
  // OPENCODE_ANYCLI_TTY=0 is equivalent to --no-tty.
  if (process.env["OPENCODE_ANYCLI_TTY"] === "0") {
    out.noTty = true
  }
  return out
}

function printHelp(): void {
  process.stdout.write(`opencode-anycli v${VERSION}

Run opencode through the locally configured cline CLI.

Usage:
  opencode-anycli [flags] [...opencode-args]

Flags:
  --config <path>          Use a specific opencode.json (default: ${defaultConfigPath()})
  --init                   (Re)create the default config from the bundled template
  --doctor                 Run the diagnostic script and exit
  --update […install.sh args]
                           git pull --ff-only inside the cloned repo, then
                           re-run install.sh (idempotent — reuses build
                           cache and config when unchanged). Anything after
                           --update is forwarded verbatim to install.sh,
                           e.g. 'opencode-anycli --update --user --sudo'.
  --setup-sudo […setup-sudo.sh args]
                           Auto-detect the system package manager (apt /
                           dnf / yum / pacman / zypper / apk) and install
                           a SCOPED NOPASSWD sudoers rule so the agent
                           can run package installs without password
                           prompts (which the agent cannot answer through
                           the cline subprocess). Forwarded args:
                             --yes      apply without confirm
                             --print    show what would be applied
                             --remove   remove the rule
                           macOS short-circuits with a no-op + advice.
  --auto-approve, --yolo, -y
                           Materialize a temp config that sets every opencode
                           permission (read/edit/bash/external_directory/...)
                           to "allow" for the spawned session. The cline
                           subprocess already runs with --yolo, so this flag
                           propagates auto-approve to the OUTER opencode
                           layer too. Per-key user-set "deny" rules in your
                           own config are still honored.
  --tty                    DEPRECATED no-op. TTY is now on by default —
                           the cline subprocess inherits the parent's
                           stdin so interactive prompts (sudo, ssh-add,
                           gh auth login) can read from your terminal.
                           Kept for backwards compatibility with existing
                           scripts.
  --no-tty                 Opt out of the TTY default. Use for CI runs or
                           when you want cline isolated from the parent's
                           stdin (e.g. piped input the user doesn't want
                           cline to consume).
  --version, -V            Print version and exit
  --help, -h               Print this help and exit

Anything not listed above is passed through to opencode unchanged.

Environment:
  OPENCODE_ANYCLI_CLINE_BIN     Override path to the cline binary
  OPENCODE_ANYCLI_CONFIG        Override config file path
  OPENCODE_ANYCLI_AUTO_APPROVE  Set to "1" to imply --auto-approve
  OPENCODE_ANYCLI_TTY           Set to "0" to imply --no-tty (default ON)
  DEBUG=1                       Print cline NDJSON events to stderr
`)
}

function runDoctor(): never {
  const scriptPath = locateRepoArtifact("doctor.sh")
  if (!scriptPath) {
    process.stderr.write("doctor.sh not found in this checkout. Run from the repo root.\n")
    process.exit(2)
  }
  const r = spawnSync("bash", [scriptPath], { stdio: "inherit" })
  process.exit(r.status ?? 1)
}

function runUpdate(installArgs: string[]): never {
  const installScript = locateRepoArtifact("install.sh")
  if (!installScript) {
    process.stderr.write("install.sh not found in this checkout. Run from the repo root.\n")
    process.exit(2)
  }
  const repoDir = dirname(installScript)

  process.stderr.write(`opencode-anycli: pulling latest in ${repoDir}\n`)
  const pull = spawnSync("git", ["-C", repoDir, "pull", "--ff-only"], { stdio: "inherit" })
  if (pull.status !== 0) {
    process.stderr.write(
      `git pull failed (exit ${pull.status ?? "?"}). Resolve the issue and re-run --update.\n` +
        "Common causes: uncommitted local changes, divergent history, network unreachable.\n",
    )
    process.exit(pull.status ?? 1)
  }

  process.stderr.write(
    `opencode-anycli: re-running install.sh ${installArgs.length > 0 ? installArgs.join(" ") : "(no extra args)"}\n`,
  )
  const install = spawnSync("bash", [installScript, ...installArgs], { stdio: "inherit", cwd: repoDir })
  process.exit(install.status ?? 1)
}

function runSetupSudo(extraArgs: string[]): never {
  // setup-sudo.sh lives at <repo>/scripts/setup-sudo.sh.
  // We locate the install.sh first to find the repo root, then resolve
  // the script path relative to it.
  const installScript = locateRepoArtifact("install.sh")
  if (!installScript) {
    process.stderr.write("install.sh not found in this checkout — cannot find scripts/setup-sudo.sh.\n")
    process.exit(2)
  }
  const repoDir = dirname(installScript)
  const setupScript = pathResolve(repoDir, "scripts", "setup-sudo.sh")
  if (!existsSync(setupScript)) {
    process.stderr.write(`setup-sudo.sh not found at ${setupScript}\n`)
    process.exit(2)
  }
  const r = spawnSync("bash", [setupScript, ...extraArgs], { stdio: "inherit", cwd: repoDir })
  process.exit(r.status ?? 1)
}

/** Walk up from this file to find a sibling artifact (install.sh / doctor.sh). */
function locateRepoArtifact(name: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  let cur = here
  for (let i = 0; i < 6; i++) {
    const candidate = pathResolve(cur, name)
    if (existsSync(candidate)) return candidate
    cur = dirname(cur)
  }
  return null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    return
  }
  if (args.version) {
    process.stdout.write(`opencode-anycli ${VERSION}\n`)
    return
  }
  if (args.doctor) {
    runDoctor()
  }
  if (args.update) {
    runUpdate(args.passthrough)
  }
  if (args.setupSudo) {
    runSetupSudo(args.passthrough)
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
    process.stderr.write(`opencode-anycli: created default config at ${cfg.path}\n`)
  }
  if (args.init) {
    process.stdout.write(`Config initialized at ${cfg.path}\n`)
    return
  }

  // If --auto-approve / --yolo / OPENCODE_ANYCLI_AUTO_APPROVE=1, materialize
  // a temp config that adds "allow" rules for every documented opencode
  // permission. The original cfg.path is left untouched. We schedule cleanup
  // of the temp file on process exit.
  let configPathForOpencode = cfg.path
  let cleanupPath: string | null = null
  if (args.autoApprove) {
    configPathForOpencode = materializeAutoApproveConfig(cfg.path)
    cleanupPath = configPathForOpencode
    process.stderr.write(
      `opencode-anycli: auto-approve enabled (temp config: ${configPathForOpencode})\n`,
    )
    const cleanup = () => {
      if (cleanupPath) {
        try { rmSync(cleanupPath, { force: true }) } catch { /* ignore */ }
        try { rmSync(dirname(cleanupPath), { recursive: true, force: true }) } catch { /* ignore */ }
        cleanupPath = null
      }
    }
    process.on("exit", cleanup)
    process.on("SIGINT", () => { cleanup(); process.exit(130) })
    process.on("SIGTERM", () => { cleanup(); process.exit(143) })
  }

  // Spawn opencode with OPENCODE_CONFIG pointing at our resolved file
  // (or the auto-approve temp file when applicable).
  // Also set XDG_CONFIG_HOME so opencode auto-discovers our wrapper-private
  // commands/agents/skills in ~/.config/opencode-anycli/opencode/ instead of
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
  //
  // OPENCODE_ANYCLI_AUTO_APPROVE: forwarded as a hint to the cline-cli
  // provider. The provider already passes --yolo to cline, so this is mainly
  // informational, but downstream code (e.g. doctor, future tooling) can key
  // off it to know auto-approve is in effect for this session.
  // Inherit stdio so the TUI works.
  const env = {
    ...process.env,
    OPENCODE_CONFIG: configPathForOpencode,
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] || `${homedir()}/.config/opencode-anycli`,
    OPENCODE_DISABLE_MODELS_FETCH: process.env["OPENCODE_DISABLE_MODELS_FETCH"] ?? "1",
    ...(args.autoApprove ? { OPENCODE_ANYCLI_AUTO_APPROVE: "1" } : {}),
    ...(args.noTty ? { OPENCODE_ANYCLI_TTY: "0" } : {}),
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
  process.stderr.write(`opencode-anycli: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
