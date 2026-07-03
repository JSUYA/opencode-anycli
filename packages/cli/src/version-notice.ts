// cline version notice — shown on opencode-anycli exit.
//
// Kept in its own module (no side effects) so it can be unit-tested without
// importing the CLI entry point, which runs main() on import.

/**
 * cline version this wrapper is tuned for. On 0.5.1 the provider auto-enables
 * the ACP transport (larger context, structured tool updates); other versions
 * fall back to subprocess mode. We surface this on exit so the user knows how
 * to switch to the optimized build.
 */
export const OPTIMAL_CLINE_VERSION = "0.5.1"

/** Extract a bare semver (e.g. "0.5.1") from cline's --version output. */
export function normalizeClineVersion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\d+\.\d+\.\d+/)
  return m ? m[0] : raw.trim() || null
}

/** Build the on-exit notice lines for a given raw cline version string. */
export function buildClineVersionNotice(rawVersion: string | null | undefined): string {
  const version = normalizeClineVersion(rawVersion)
  if (version === OPTIMAL_CLINE_VERSION) {
    return `\nopencode-anycli: cline ${version} — optimized build (ACP enabled). ✓\n`
  }
  const shown = version ?? "unknown"
  return [
    "",
    "────────────────────────────────────────────────────────────────────",
    `opencode-anycli is optimized for cline ${OPTIMAL_CLINE_VERSION}.`,
    `Installed cline version: ${shown} (not ${OPTIMAL_CLINE_VERSION} — ACP disabled, running subprocess mode).`,
    "",
    `To install the optimized version:`,
    "",
    "  npm uninstall -g cline",
    `  npm install -g cline@${OPTIMAL_CLINE_VERSION} --registry https://bart.sec.samsung.net/artifactory/api/npm/coding-assistant-npm-remote/`,
    "────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n")
}

/**
 * Print the cline-version notice AFTER opencode exits (the TUI has torn down,
 * so stderr is visible again). On the optimized version it's a one-line ✓; on
 * any other version it explains the ACP fallback and prints the reinstall guide.
 */
export function printClineVersionExitNotice(rawVersion: string | null | undefined): void {
  process.stderr.write(buildClineVersionNotice(rawVersion))
}
