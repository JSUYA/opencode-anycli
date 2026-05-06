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
import { materializeTempConfig } from "./temp-config.js"
import { lookupClineCost } from "./cline-pricing.js"
import { readGlobalState } from "@opencode-anycli/provider-cline-cli"

const VERSION = "0.1.0"

interface Args {
  config?: string | undefined
  init?: boolean | undefined
  doctor?: boolean | undefined
  diagPricing?: boolean | undefined
  update?: boolean | undefined
  version?: boolean | undefined
  help?: boolean | undefined
  autoApprove?: boolean | undefined
  noTty?: boolean | undefined
  /**
   * --allow-dangerously-skip-permissions: re-execute the entire session
   * under sudo (one password prompt up front), so the inner cline + bash
   * subprocesses run as root and can install packages, start daemons, etc.
   * without ever prompting again. Implies --auto-approve. No persistent
   * sudoers / configuration changes are made.
   */
  dangerouslySkipPermissions?: boolean | undefined
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
      case "--diag-pricing":
        // Hidden diagnostic flag used by doctor.sh: print resolved cline
        // pricing as JSON and exit. Stays out of --help on purpose.
        out.diagPricing = true
        break
      case "--update":
        // Everything AFTER --update is forwarded to install.sh as-is, so the
        // user can run `opencode-anycli --update --user --skip-build` etc.
        out.update = true
        out.passthrough.push(...argv.slice(i + 1))
        i = argv.length
        break
      case "--allow-dangerously-skip-permissions":
      case "--dangerously-skip-permissions":
        // Single-flag escape hatch for "the agent needs to run privileged
        // commands during this session." Implies --auto-approve so opencode's
        // own permission prompts are also silenced. The actual elevation
        // (re-exec under sudo) is performed in main(), once we know we are
        // about to launch the session (not for --doctor / --update).
        out.dangerouslySkipPermissions = true
        out.autoApprove = true
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
  // OPENCODE_ANYCLI_DANGEROUS=1 is equivalent to --allow-dangerously-skip-permissions.
  if (process.env["OPENCODE_ANYCLI_DANGEROUS"] === "1") {
    out.dangerouslySkipPermissions = true
    out.autoApprove = true
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
  --allow-dangerously-skip-permissions
  --dangerously-skip-permissions
                           Re-exec the entire opencode-anycli session
                           under 'sudo -E' so the inner cline + bash
                           subprocesses run as root. The agent can then
                           run apt/dnf install, systemctl, docker, etc.
                           without ever hitting a password prompt. ONE
                           sudo prompt at startup; nothing is written
                           to /etc/sudoers.d. Implies --auto-approve.
                           Trade-off: files created during the session
                           will be root-owned. Use only when you trust
                           the agent's full action set.
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

Ctrl+C handling:
  Inside the opencode TUI (terminal in raw mode), Ctrl+C is handled by
  opencode itself. Our shipped tui.json removes ctrl+c from app_exit, so
  Ctrl+C in the TUI only clears the input field — no accidental session
  exit. To leave the TUI, type ':exit' / ':quit' / ':q' in the prompt.

  Outside the TUI (boot window, opencode run, errors, post-teardown —
  cooked-mode terminal where Ctrl+C is delivered as SIGINT), the wrapper
  takes over: press Ctrl+C once to arm a 2-second exit window, press it
  again within the window to tear the whole session down (SIGTERM the
  opencode + cline subprocess group, exit code 130). A single press
  followed by inactivity quietly resets.

Anything not listed above is passed through to opencode unchanged.

Environment:
  OPENCODE_ANYCLI_CLINE_BIN     Override path to the cline binary
  OPENCODE_ANYCLI_CONFIG        Override config file path
  OPENCODE_ANYCLI_AUTO_APPROVE  Set to "1" to imply --auto-approve
  OPENCODE_ANYCLI_TTY           Set to "0" to imply --no-tty (default ON)
  OPENCODE_ANYCLI_DANGEROUS     Set to "1" to imply
                                --allow-dangerously-skip-permissions
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

/**
 * Re-exec the current process under `sudo -E` so the rest of the session
 * (and every subprocess opencode/cline spawn) runs as root and never hits
 * a sudo password prompt mid-run. Returns immediately if we are already
 * root, the elevation marker env var is set, or the re-exec marker says
 * we already came from a previous re-exec.
 *
 * Caller is responsible for printing intent BEFORE this is invoked, so the
 * user understands the upcoming sudo prompt.
 */
function ensureElevated(): void {
  // Already root? Nothing to do.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  if (isRoot) return
  // Re-exec marker — guard against any accidental loop.
  if (process.env["OPENCODE_ANYCLI_ELEVATED"] === "1") return

  // Locate sudo. If it isn't available we cannot honor the flag.
  const sudoCheck = spawnSync("sh", ["-c", "command -v sudo"], { stdio: "pipe" })
  if (sudoCheck.status !== 0) {
    process.stderr.write(
      "--allow-dangerously-skip-permissions: 'sudo' not found on PATH.\n" +
        "  Either run opencode-anycli as root directly, or install sudo.\n",
    )
    process.exit(2)
  }

  process.stderr.write(
    [
      "",
      "⚠  --allow-dangerously-skip-permissions: re-executing under sudo.",
      "   The entire opencode-anycli session (and every subprocess it spawns)",
      "   will run as root. Files created during the session will be",
      "   root-owned. Press Ctrl-C now to abort, or enter your password.",
      "",
    ].join("\n"),
  )

  // Strip our flag from argv so the re-execed instance doesn't recurse.
  const cleaned = process.argv.slice(2).filter(
    (a) =>
      a !== "--allow-dangerously-skip-permissions" &&
      a !== "--dangerously-skip-permissions",
  )

  // sudo's `secure_path` setting in /etc/sudoers REPLACES PATH after env_keep,
  // so neither `-E` nor `--preserve-env=PATH` reliably propagates the user's
  // PATH (where opencode / cline / nvm-managed node typically live, e.g.
  // ~/.nvm/versions/node/<v>/bin). We work around this by chaining the
  // elevated child through `env VAR=val ...`, which sets the env vars
  // unconditionally AFTER sudo has finished scrubbing them. HOME is also
  // re-pinned to the original user's home so the wrapper still finds the
  // user's config (~/.config/opencode-anycli/...) instead of /root/.config/.
  const passthrough: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/root",
    OPENCODE_ANYCLI_ELEVATED: "1",
  }
  // Note: USER / LOGNAME deliberately NOT propagated — let sudo set them
  // to "root" so tools that key off the username (git commit author, etc.)
  // see the actual euid rather than a lie. HOME is the only identity-ish
  // var we override, because the wrapper's whole config-discovery flow
  // assumes it points at the user's home.
  for (const k of [
    "TERM",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG",
    "OPENCODE_ANYCLI_CONFIG",
    "OPENCODE_ANYCLI_CLINE_BIN",
    "OPENCODE_ANYCLI_AUTO_APPROVE",
    "OPENCODE_ANYCLI_TTY",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "DEBUG",
  ]) {
    const v = process.env[k]
    if (v !== undefined) passthrough[k] = v
  }
  const envArgs = Object.entries(passthrough).map(([k, v]) => `${k}=${v}`)

  const r = spawnSync(
    "sudo",
    [
      "-E",
      "--",
      "env",
      ...envArgs,
      process.execPath,
      process.argv[1] ?? "",
      ...cleaned,
    ],
    { stdio: "inherit" },
  )
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
  if (args.diagPricing) {
    const gs = readGlobalState()
    const provider = gs && typeof gs["actModeApiProvider"] === "string" ? (gs["actModeApiProvider"] as string) : null
    const model = gs && typeof gs["actModeApiModelId"] === "string" ? (gs["actModeApiModelId"] as string) : null
    const match = lookupClineCost({ providerId: provider, modelId: model })
    process.stdout.write(JSON.stringify({ provider, model, match }) + "\n")
    return
  }
  if (args.update) {
    runUpdate(args.passthrough)
  }

  // Elevate BEFORE the pre-flight checks: those checks depend on PATH /
  // env, which sudo will preserve via -E, and we want any subsequent
  // log output (including "spawned opencode") to come from the elevated
  // process so it accurately reflects where files end up.
  if (args.dangerouslySkipPermissions) {
    ensureElevated()
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

  // Materialise a session-scoped temp config when we need to:
  //   - turn on auto-approve (--auto-approve / --yolo / OPENCODE_ANYCLI_AUTO_APPROVE)
  //   - inject `provider.cline.models.<id>.cost` so the TUI can show real
  //     "$X.XX spent" lines instead of always-$0.00. The cost rates are
  //     looked up from cline's currently-configured provider+model
  //     (~/.cline/data/globalState.json) against our static pricing table.
  //
  // Both mutations live in one temp file. Original cfg.path is never
  // touched. We schedule cleanup of the temp file on process exit.
  let configPathForOpencode = cfg.path
  let cleanupPath: string | null = null
  const globalState = readGlobalState()
  const clineModel = globalState
    ? {
        providerId: typeof globalState["actModeApiProvider"] === "string" ? (globalState["actModeApiProvider"] as string) : null,
        modelId: typeof globalState["actModeApiModelId"] === "string" ? (globalState["actModeApiModelId"] as string) : null,
      }
    : null
  const tempConfig = materializeTempConfig(cfg.path, {
    autoApprove: !!args.autoApprove,
    clineModel,
  })
  if (tempConfig) {
    configPathForOpencode = tempConfig.path
    cleanupPath = tempConfig.path
    for (const note of tempConfig.notes) process.stderr.write(`opencode-anycli: ${note}\n`)
  }
  const cleanupTempConfig = () => {
    if (cleanupPath) {
      try { rmSync(cleanupPath, { force: true }) } catch { /* ignore */ }
      try { rmSync(dirname(cleanupPath), { recursive: true, force: true }) } catch { /* ignore */ }
      cleanupPath = null
    }
  }
  process.on("exit", cleanupTempConfig)
  process.on("SIGTERM", () => { cleanupTempConfig(); process.exit(143) })

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
  // XDG_CONFIG_HOME redirect: most desktop shells pre-set XDG_CONFIG_HOME
  // to "$HOME/.config" (literally that string, not unset), so a previous
  // version that did `process.env["XDG_CONFIG_HOME"] || …` always inherited
  // the parent's value and silently failed to redirect — opencode then
  // discovered tui.json / commands / agents under ~/.config/opencode/
  // (the user's main opencode dir) instead of our wrapper-private space.
  // OPENCODE_CONFIG masked half the breakage by pointing opencode.json
  // explicitly, but anything XDG-discovered (tui.json keybinds, skills,
  // commands, agents) was reading from the wrong place. Force-override.
  // Power users who really need a different dir can set OPENCODE_ANYCLI_XDG.
  const wrapperXdg =
    process.env["OPENCODE_ANYCLI_XDG"] || `${homedir()}/.config/opencode-anycli`
  const env = {
    ...process.env,
    OPENCODE_CONFIG: configPathForOpencode,
    XDG_CONFIG_HOME: wrapperXdg,
    OPENCODE_DISABLE_MODELS_FETCH: process.env["OPENCODE_DISABLE_MODELS_FETCH"] ?? "1",
    ...(args.autoApprove ? { OPENCODE_ANYCLI_AUTO_APPROVE: "1" } : {}),
    ...(args.noTty ? { OPENCODE_ANYCLI_TTY: "0" } : {}),
  }
  // Spawn opencode with `detached: true` so it becomes the leader of its
  // own process group. This lets the wrapper own SIGINT from the controlling
  // TTY: pressing Ctrl+C only signals the wrapper, NOT the child, so we can
  // implement a double-press confirm-to-exit gesture without losing
  // opencode's own session-interrupt feature (we forward the first press to
  // the child group below).
  const child = spawn("opencode", args.passthrough, { stdio: "inherit", env, detached: true })
  installCtrlCExitGuard(child)
  child.on("close", (code, signal) => {
    cleanupTempConfig()
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

/**
 * Wire up the wrapper's Ctrl+C double-press exit guard.
 *
 * Scope: this handler only fires when the controlling TTY is in cooked
 * mode and Ctrl+C is delivered as a SIGINT signal. That covers the
 * brief boot window before opencode initialises its TUI, the entire
 * lifetime of `opencode run` (non-TUI) sessions, and any post-TUI
 * cooked-mode output. Inside the opencode TUI the terminal is in raw
 * mode (ISIG off) and Ctrl+C arrives as the byte 0x03 directly to
 * opencode's keybind layer — the wrapper never sees it. For "no
 * accidental in-TUI exit" we instead rebind opencode's `app_exit` to
 * drop ctrl+c via templates/tui.json (the user types `:exit`/`:quit`
 * to leave the TUI).
 *
 * Behaviour for the cooked-mode path:
 *   1st Ctrl+C — print a yellow one-line hint and arm a 2-second window.
 *                We deliberately do NOT forward SIGINT to opencode: the
 *                child group has no SIGINT handler and would die on the
 *                first signal, defeating the purpose. opencode keeps
 *                running undisturbed.
 *   2nd Ctrl+C within 2 s — SIGTERM the detached child group (which
 *                propagates to cline and any inner subprocesses), schedule
 *                a 1 s SIGKILL fallback, and exit the wrapper with 130.
 *   No 2nd press — the window quietly resets; nothing else changes.
 */
function installCtrlCExitGuard(child: ReturnType<typeof spawn>): void {
  const EXIT_WINDOW_MS = 2000
  let armed = false
  let armedTimer: NodeJS.Timeout | null = null

  const killChildGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch { /* ignore */ }
  }

  process.on("SIGINT", () => {
    if (armed) {
      if (armedTimer) clearTimeout(armedTimer)
      armed = false
      process.stderr.write("\r\x1b[2K\x1b[1;31m^^C — exiting opencode-anycli.\x1b[0m\n")
      killChildGroup("SIGTERM")
      setTimeout(() => killChildGroup("SIGKILL"), 1000).unref()
      process.exit(130)
    }

    armed = true
    process.stderr.write(
      "\r\x1b[2K\x1b[1;33m^C — press Ctrl+C again within 2s to exit opencode-anycli.\x1b[0m\n",
    )
    armedTimer = setTimeout(() => {
      armed = false
      armedTimer = null
    }, EXIT_WINDOW_MS)
    armedTimer.unref()
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`opencode-anycli: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
