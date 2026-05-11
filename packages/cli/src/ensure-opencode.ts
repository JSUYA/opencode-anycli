// Verify that the `opencode` and `cline` binaries are reachable on PATH
// AND can execute their --version handshake.
//
// History note: an earlier version of this file collapsed every spawn
// outcome other than `status === 0` into "binary not found on PATH",
// which produced a wildly misleading error in a real scenario observed
// in the wild. The user's system had Node 18.19.1 (Ubuntu 22.04 default)
// while cline's transitive `string-width` dependency uses the regex `v`
// flag — a V8 12.0+ feature, i.e. Node 20+. On Node 18 cline crashed
// with `SyntaxError: Invalid regular expression flags` during module
// load, exit code != 0. Our check then told the user the binary was
// missing from PATH, when in reality it was sitting right there but
// couldn't even parse itself. The user spent significant time chasing
// PATH/direnv/login-shell theories before the real cause (node version)
// surfaced.
//
// Lesson: differentiate "spawn could not find the executable" (ENOENT)
// from "spawn found and ran the executable but it exited non-zero".
// Surface stderr/stdout in the latter case so the user can see the
// underlying error directly. Detect the specific Node-too-old fingerprint
// and call it out, since it's the single most common cause for the
// "found but crashes on --version" mode in this codebase.

import { spawnSync } from "node:child_process"

export interface BinaryCheck {
  ok: boolean
  version: string | null
  hint: string
}

const NODE_MIN_MAJOR = 20

function currentNodeMajor(): number {
  const v = (process.versions.node || "0").split(".")[0] ?? "0"
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

function looksLikeNodeTooOld(output: string): boolean {
  // Real crash transcript from cline on Node 18:
  //   SyntaxError: Invalid regular expression flags
  //   const zeroWidthClusterRegex = /…$/v;
  // We match either the explicit message or the bare `/.../v` literal
  // that the V8 parser dumps a caret under. Loose match because the
  // exact wording varies by Node version.
  return (
    /SyntaxError.*[Ii]nvalid regular expression/.test(output) ||
    /\/[^\n]*\$\/v[;,]?\s*$/m.test(output) ||
    /Unexpected token.*v\b/.test(output)
  )
}

function describeRunFailure(
  bin: string,
  label: string,
  installCmd: string,
  r: ReturnType<typeof spawnSync>,
): BinaryCheck {
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code
  // ENOENT (or EACCES on an unreadable directory) genuinely means the
  // binary is not reachable. Everything else means we did invoke it.
  if (errCode === "ENOENT") {
    return {
      ok: false,
      version: null,
      hint: [
        `  ${bin} binary not found on PATH.`,
        `  Install: ${installCmd}`,
        ...(bin === "cline"
          ? [
              "  Then run `cline` once to configure your model and credentials.",
            ]
          : [
              "  Or download from: https://github.com/sst/opencode/releases",
            ]),
      ].join("\n"),
    }
  }

  // Binary was found and invoked; --version exited non-zero (or threw
  // a spawn error other than ENOENT). Show the actual output so the
  // user can read the real failure for themselves.
  const stderr = (r.stderr ?? "").toString().trim()
  const stdout = (r.stdout ?? "").toString().trim()
  const combined = [stderr, stdout].filter(Boolean).join("\n").trim()
  const where = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" })
  const resolvedPath = (where.stdout || "").trim() || "(unknown)"
  const nodeMajor = currentNodeMajor()
  const nodeMismatch = looksLikeNodeTooOld(combined) || nodeMajor < NODE_MIN_MAJOR

  const lines: string[] = []
  lines.push(
    `  ${bin} found at ${resolvedPath} but '--version' failed ` +
      `(exit ${r.status ?? "?"}${errCode ? `, ${errCode}` : ""}).`,
  )
  if (nodeMismatch) {
    lines.push(
      `  This wrapper and ${label} require Node ${NODE_MIN_MAJOR}+. ` +
        `You are running Node ${process.versions.node}. ` +
        `cline/opencode depend on string-width which uses the regex \`v\` flag — ` +
        `a V8 12.0+ feature unavailable in Node 18.`,
    )
    lines.push(
      `  Fix: install Node ${NODE_MIN_MAJOR}+ (e.g. via nvm: ` +
        `\`nvm install 22 && nvm alias default 22\`), open a new shell, retry.`,
    )
  } else {
    lines.push(
      `  Re-run \`${bin} --version\` directly to see why it exits non-zero, ` +
        `then re-launch opencode-anycli.`,
    )
  }
  if (combined) {
    lines.push("  ---- output ----")
    for (const line of combined.split("\n")) lines.push("  " + line)
  }
  return { ok: false, version: null, hint: lines.join("\n") }
}

export function checkOpencode(): BinaryCheck {
  const r = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    return describeRunFailure("opencode", "opencode", "npm install -g opencode-ai", r)
  }
  return {
    ok: true,
    version: (r.stdout || r.stderr || "").trim().split("\n")[0] ?? null,
    hint: "",
  }
}

export function checkCline(): BinaryCheck {
  const r = spawnSync("cline", ["--version"], { encoding: "utf8" })
  if (r.error || r.status !== 0) {
    return describeRunFailure("cline", "cline", "npm install -g cline", r)
  }
  return {
    ok: true,
    version: (r.stdout || r.stderr || "").trim().split("\n")[0] ?? null,
    hint: "",
  }
}
