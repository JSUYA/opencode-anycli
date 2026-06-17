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

const VERSION = "0.1.0"

interface Args {
  config?: string | undefined
  init?: boolean | undefined
  doctor?: boolean | undefined
  fix?: boolean | undefined
  fixYes?: boolean | undefined
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
      case "--fix":
        out.fix = true
        break
      case "--fix-yes":
        // Bundle of --fix --yes (skip-confirm). Useful for scripts /
        // CI / docker images that want a one-shot recovery without
        // interactive prompts.
        out.fix = true
        out.fixYes = true
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
  --fix                    Interactive recovery for known broken
                           states: foreign-owned files in opencode /
                           cline data dirs (left over from past
                           --allow-dangerously-skip-permissions runs),
                           a corrupt opencode SQLite DB (PRAGMA
                           wal_checkpoint failure on startup), and
                           root-owned entries in ~/.npm/_cacache.
                           Each step prompts before changing anything.
  --fix-yes                --fix with every prompt auto-confirmed.
                           For scripted recovery / CI / containers.
  --update […install.sh args]
                           Auto-stash any uncommitted local changes
                           (tracked + untracked), git pull --ff-only inside
                           the cloned repo, then re-run install.sh
                           (idempotent — reuses build cache and config when
                           unchanged), then 'git stash pop' the local
                           changes back. If pop conflicts, the stash stays
                           in stash@{0} so nothing is lost. Anything after
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

function runFix(autoYes: boolean): never {
  const scriptPath = locateRepoArtifact("fix.sh")
  if (!scriptPath) {
    process.stderr.write("fix.sh not found in this checkout. Run from the repo root.\n")
    process.exit(2)
  }
  const args = autoYes ? [scriptPath, "--yes"] : [scriptPath]
  const r = spawnSync("bash", args, { stdio: "inherit" })
  process.exit(r.status ?? 1)
}

function runUpdate(installArgs: string[]): never {
  const installScript = locateRepoArtifact("install.sh")
  if (!installScript) {
    process.stderr.write("install.sh not found in this checkout. Run from the repo root.\n")
    process.exit(2)
  }
  const repoDir = dirname(installScript)

  // Stash any uncommitted local changes (tracked + untracked) so a
  // fast-forward pull doesn't fail. We restore them with `git stash pop`
  // after install.sh runs. If the pop conflicts (e.g. the user's local
  // edits collide with the freshly-pulled code) we leave the stash
  // intact and surface a clear hint instead of silently dropping it.
  const status = spawnSync("git", ["-C", repoDir, "status", "--porcelain"], { stdio: ["ignore", "pipe", "pipe"] })
  const hasChanges = status.status === 0 && status.stdout.length > 0
  let stashed = false
  if (hasChanges) {
    const stashMsg = `opencode-anycli auto-stash ${new Date().toISOString()}`
    process.stderr.write(`opencode-anycli: stashing local changes — "${stashMsg}"\n`)
    const stash = spawnSync(
      "git",
      ["-C", repoDir, "stash", "push", "--include-untracked", "-m", stashMsg],
      { stdio: "inherit" },
    )
    if (stash.status !== 0) {
      process.stderr.write(
        `git stash failed (exit ${stash.status ?? "?"}). Aborting --update so we don't lose local edits.\n`,
      )
      process.exit(stash.status ?? 1)
    }
    stashed = true
  }

  const popStashAndExit = (code: number): never => {
    if (stashed) {
      process.stderr.write("opencode-anycli: restoring stashed local changes — git stash pop\n")
      const pop = spawnSync("git", ["-C", repoDir, "stash", "pop"], { stdio: "inherit" })
      if (pop.status !== 0) {
        process.stderr.write(
          "opencode-anycli: 'git stash pop' had conflicts or failed.\n" +
            "  Your changes are still safe in stash@{0}.\n" +
            "  Run 'git -C " +
            repoDir +
            " stash list' to see them, then 'git stash pop' (or 'git stash apply') when ready.\n",
        )
      }
    }
    process.exit(code)
  }

  process.stderr.write(`opencode-anycli: pulling latest in ${repoDir}\n`)
  const pull = spawnSync("git", ["-C", repoDir, "pull", "--ff-only"], { stdio: "inherit" })
  if (pull.status !== 0) {
    process.stderr.write(
      `git pull failed (exit ${pull.status ?? "?"}). ` +
        "Common causes: divergent history (need rebase/merge), network unreachable.\n",
    )
    popStashAndExit(pull.status ?? 1)
  }

  process.stderr.write(
    `opencode-anycli: re-running install.sh ${installArgs.length > 0 ? installArgs.join(" ") : "(no extra args)"}\n`,
  )
  const install = spawnSync("bash", [installScript, ...installArgs], { stdio: "inherit", cwd: repoDir })
  popStashAndExit(install.status ?? 1)
  // TS can't always carry the `never` return of the inner arrow function
  // back up to the enclosing scope, so make the unreachable explicit.
  throw new Error("unreachable: popStashAndExit returned without exiting")
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

/**
 * Hard-fail the wrapper if the active Node major is below the floor we
 * actually need. Why this exists despite package.json already declaring
 * `engines.node >= 20`: engines is advisory and Node ignores it at run
 * time, so a user on the Ubuntu 22.04 default (`/usr/bin/node` v18.19.1)
 * will see the wrapper boot, call `cline --version` under that same old
 * Node, and watch cline crash with `SyntaxError: Invalid regular
 * expression flags` because string-width uses the regex `v` flag (V8
 * 12+, i.e. Node 20+). Our previous error message in that case was
 * "cline binary not found on PATH", which sent a real user on a long
 * direnv/PATH-chasing wild goose chase before the node version showed
 * itself. Failing here, with the node version stated up front, makes
 * the diagnosis obvious.
 *
 * --help / --version / --doctor are exempt: they are info-only or are
 * explicitly meant to diagnose exactly this situation.
 */
function ensureNodeVersion(): void {
  const major = parseInt((process.versions.node || "0").split(".")[0] ?? "0", 10)
  if (Number.isFinite(major) && major >= 20) return
  process.stderr.write(
    [
      `opencode-anycli requires Node 20+, but you are running Node ${process.versions.node}.`,
      ``,
      `Why this hard-fails (instead of warning):`,
      `  cline depends on string-width, which uses the regex \`v\` flag — a V8 12+`,
      `  feature unavailable in Node 18. On older Node, cline throws SyntaxError`,
      `  during module load and surfaces as a misleading "binary not found on PATH"`,
      `  error downstream.`,
      ``,
      `Fix: install Node 20+ (nvm, fnm, NodeSource, or your distro's newer package),`,
      `put it on PATH, verify with \`node -v\`, then re-run opencode-anycli.`,
      ``,
    ].join("\n"),
  )
  process.exit(1)
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
  // --doctor is the canonical "tell me why my install is broken"
  // entry point — it has to run even on a too-old node so the user
  // can collect diagnostics.
  if (args.doctor) {
    runDoctor()
  }

  // Everything else (running an actual opencode session, --fix, --update)
  // depends on Node 20+ either directly or via cline/opencode. Gate here
  // so the failure mode is "Node too old" instead of a misleading
  // downstream symptom.
  ensureNodeVersion()

  if (args.fix) {
    runFix(!!args.fixYes)
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

  // Materialise a session-scoped temp config when --auto-approve / --yolo /
  // OPENCODE_ANYCLI_AUTO_APPROVE is set. The original cfg.path is never
  // touched. We schedule cleanup of the temp file on process exit.
  let configPathForOpencode = cfg.path
  let cleanupPath: string | null = null
  const tempConfig = materializeTempConfig(cfg.path, {
    autoApprove: !!args.autoApprove,
  })
  if (tempConfig) {
    configPathForOpencode = tempConfig.path
    cleanupPath = tempConfig.path
    for (const note of tempConfig.notes) process.stderr.write(`opencode-anycli: ${note}\n`)
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
  //   (a) the only usable providers in this wrapper are the local CLI-backed
  //       ones declared in `enabled_providers` (cline / claude / codex),
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
