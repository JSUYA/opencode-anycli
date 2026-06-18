#!/usr/bin/env bash
# doctor.sh — diagnostic report for opencode-anycli.
# Prints a colored status report and exits 0 if everything passes.
set -u

if [ -t 1 ]; then
  GREEN="\033[1;32m"; YELLOW="\033[1;33m"; RED="\033[1;31m"; BLUE="\033[1;34m"; DIM="\033[2m"; RESET="\033[0m"
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; DIM=""; RESET=""
fi

PASS=0; FAIL=0
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; PASS=$((PASS+1)); }
nope() { printf "  ${RED}✗${RESET} %s\n" "$*";   FAIL=$((FAIL+1)); }
note() { printf "  ${DIM}↳ %s${RESET}\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
section() { printf "\n${BLUE}▶ %s${RESET}\n" "$*"; }

printf "${BLUE}                                 ▄                               ▄    ▄   ${RESET}\n"
printf "${BLUE}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█      ▄▀▀▄ █▀▀▄ █  █ █▀▀▀ █        ${RESET}\n"
printf "${BLUE}█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀ ▄▄▄▄ █▀▀█ █  █ ▀▄▄█ █    █    █   ${RESET}\n"
printf "${BLUE}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀      ▀  ▀ ▀  ▀ ▄▄▄▀ ▀▀▀▀ ▀    ▀   ${RESET}\n"
printf "\n"
printf "${BLUE}opencode-anycli doctor${RESET}\n"
printf "${DIM}Diagnostic report - %s${RESET}\n" "$(date '+%Y-%m-%d %H:%M:%S')"

OS_NAME="$(uname -s)"

# ─── Node ─────────────────────────────────────────────────────────────────────
section "Node.js"
if command -v node >/dev/null 2>&1; then
  NV="$(node -v 2>/dev/null | sed 's/^v//')"
  NM="${NV%%.*}"
  if [ "$NM" -ge 20 ] 2>/dev/null; then
    ok "node v$NV (>= 20)"
  else
    nope "node v$NV (need >= 20)"
  fi
else
  nope "node not found on PATH"
fi

# Shared helper: report on a CLI binary by its --version handshake.
#
# Why this is non-trivial: the previous implementation took the first
# line of `<bin> --version 2>&1` and reported it as the "version" with
# a ✓ marker, with no exit-code check. When cline crashes on Node 18
# with `SyntaxError: Invalid regular expression flags` (string-width
# uses the regex `v` flag, V8 12+ only), the first line of stderr is
# the file path of the failing module — and doctor cheerfully reported
# "✓ cline found: file:///.../string-width/index.js:19". A real user
# wasted significant time on PATH theories before the underlying Node
# version surfaced.
#
# This helper instead:
#   * Captures stdout AND stderr separately, plus the real exit code.
#   * Differentiates "not on PATH" from "found but exited non-zero".
#   * In the crash case, surfaces the resolved path + stderr so the
#     user can read the actual error, and adds an explicit Node
#     version hint if the output fingerprints the regex `v` flag
#     SyntaxError (or if we're already running on Node < 20).
check_bin_version() {
  # check_bin_version <binary> <human-label> <install-hint>
  local bin="$1" label="$2" install_hint="$3"
  if ! command -v "$bin" >/dev/null 2>&1; then
    nope "$label not on PATH"
    note "Install: $install_hint"
    return 1
  fi
  local resolved out_file err_file rc
  resolved="$(command -v "$bin")"
  out_file="$(mktemp)"; err_file="$(mktemp)"
  "$bin" --version >"$out_file" 2>"$err_file"
  rc=$?
  local combined
  combined="$(cat "$err_file" "$out_file" 2>/dev/null)"
  if [ "$rc" -eq 0 ]; then
    local version
    version="$(head -n1 "$out_file" 2>/dev/null)"
    [ -z "$version" ] && version="$(head -n1 "$err_file" 2>/dev/null)"
    ok "$label found: ${version:-(no --version output)}"
    note "$resolved"
    rm -f "$out_file" "$err_file"
    return 0
  fi
  nope "$label found at $resolved but '--version' failed (exit $rc)"
  # Fingerprint the regex-v-flag SyntaxError, the single recurring
  # cause we've documented. Match either the explicit message or the
  # bare `/.../v` literal that V8 prints under a caret.
  local node_major
  node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
  if printf '%s' "$combined" | grep -qE 'SyntaxError.*[Ii]nvalid regular expression' \
     || printf '%s' "$combined" | grep -qE '/[^[:space:]]*\$/v[;,]?[[:space:]]*$' \
     || { [ -n "$node_major" ] && [ "$node_major" -lt 20 ] 2>/dev/null; }; then
    note "Looks like a Node version mismatch — $label requires Node 20+."
    note "  (cline/opencode depend on string-width which uses the regex \`v\` flag,"
    note "   a V8 12+ feature unavailable in Node 18.)"
    note "Fix: nvm install 22 && nvm alias default 22, open a new shell, retry."
  else
    note "Re-run \`$bin --version\` directly to read the failure."
  fi
  if [ -s "$err_file" ]; then
    note "---- $bin --version stderr ----"
    sed 's/^/    /' "$err_file"
  fi
  rm -f "$out_file" "$err_file"
  return 1
}

# ─── opencode ─────────────────────────────────────────────────────────────────
section "opencode"
OPENCODE_OK=0
if check_bin_version opencode "opencode" "npm install -g opencode-ai"; then
  OPENCODE_OK=1
fi

# ─── cline ────────────────────────────────────────────────────────────────────
section "cline"
CLINE_MIN_VER="0.5.1"
CLINE_OK=0
if check_bin_version cline "cline" "npm install -g cline"; then
  cline_ver="$(cline --version 2>&1 | head -n1 | sed -E 's/^v//; s/[[:space:]]+$//')"
  # Pure-bash semver compare — same logic as install.sh's opencode check.
  _cline_meets_min=0
  (
    IFS=.
    # shellcheck disable=SC2206
    h=($cline_ver) n=($CLINE_MIN_VER)
    for i in 0 1 2; do
      hp="${h[$i]:-0}"; np="${n[$i]:-0}"
      hp="${hp%%[!0-9]*}"; np="${np%%[!0-9]*}"
      hp="${hp:-0}"; np="${np:-0}"
      [ "$hp" -gt "$np" ] && exit 0
      [ "$hp" -lt "$np" ] && exit 1
    done
    exit 0
  ) && _cline_meets_min=1
  if [ "$_cline_meets_min" -eq 1 ]; then
    ok "cline $cline_ver ≥ $CLINE_MIN_VER (minimum required)"
    CLINE_OK=1
  else
    nope "cline $cline_ver < $CLINE_MIN_VER — versions below $CLINE_MIN_VER may not work correctly"
    note "Upgrade: npm install -g cline@latest"
    note "  (manual recovery if ENOTEMPTY:)"
    note "  rm -rf \"\$(npm prefix -g)/lib/node_modules/cline\" && npm install -g cline@latest"
  fi
fi

# ─── cline config ─────────────────────────────────────────────────────────────
section "cline configuration / config"
GS="$HOME/.cline/data/globalState.json"
if [ -f "$GS" ]; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$GS" >/dev/null 2>&1; then
    ok "$GS  (valid JSON)"
    PROV="$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.actModeApiProvider||'(unset)'))" "$GS" 2>/dev/null)"
    MODEL="$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.actModeApiModelId||'(unset)'))" "$GS" 2>/dev/null)"
    note "actModeApiProvider = $PROV"
    note "actModeApiModelId  = $MODEL"
  else
    nope "$GS exists but is not valid JSON"
  fi
else
  nope "$GS not found"
  note "Run cline once and complete its first-run setup."
fi

# ─── opencode-anycli config ──────────────────────────────────────────────────
section "opencode-anycli configuration / config"
OCC="$HOME/.config/opencode-anycli/opencode/opencode.json"
if [ -f "$OCC" ]; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$OCC" >/dev/null 2>&1; then
    ok "$OCC  (valid JSON)"
  else
    nope "$OCC exists but is not valid JSON"
  fi
else
  nope "$OCC not found"
  note "Run ./install.sh to install the default config."
fi

# ─── LSP (right-hand "LSP" panel) ────────────────────────────────────────────
# Two things have to be true for the right-hand "LSPs will activate as files
# are read" panel to populate when cline reads a file:
#   1. the wrapper config has `lsp: true` (or an `lsp: {…}` map) so opencode
#      doesn't disable its LSP service at startup with "all LSPs are disabled";
#   2. for .ts / .tsx / .js files specifically, typescript-language-server
#      must be on PATH (opencode does NOT auto-download this one).
# Other languages' LSP servers are auto-downloaded by opencode on first use,
# so we don't check those here.
section "LSP panel ('LSPs will activate as files are read')"
if [ -f "$OCC" ]; then
  # `node` is already required upstream in this script; use it for a strict
  # JSON check rather than fragile grep. Reports:
  #   - "true"        → opencode auto-enables its bundled LSP set
  #   - "false"/"missing" → opencode logs "all LSPs are disabled" at startup
  #   - "object"      → user-customised LSP config; assumed intentional
  LSP_FLAG="$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (c.lsp === true) process.stdout.write('true');
      else if (c.lsp === false) process.stdout.write('false');
      else if (c.lsp === undefined || c.lsp === null) process.stdout.write('missing');
      else if (typeof c.lsp === 'object') process.stdout.write('object');
      else process.stdout.write('other');
    } catch { process.stdout.write('error'); }
  " "$OCC" 2>/dev/null)"
  case "$LSP_FLAG" in
    true)    ok 'config has "lsp": true (LSP panel will populate)' ;;
    object)  ok 'config has "lsp": {…} (custom LSP map; assumed intentional)' ;;
    false)   nope 'config has "lsp": false → LSP panel will never populate'
             note "Edit $OCC and set \"lsp\": true." ;;
    missing) nope 'config has no "lsp" key → opencode disables all LSPs by default'
             note "Edit $OCC and add \"lsp\": true (top-level), or rerun ./install.sh." ;;
    other|error)
             warn "could not determine the lsp setting in $OCC" ;;
  esac
else
  warn "skipping (config file missing — see check above)"
fi

if command -v typescript-language-server >/dev/null 2>&1; then
  TLS_VER="$(typescript-language-server --version 2>&1 | head -n1)"
  ok "typescript-language-server: $TLS_VER"
  note "$(command -v typescript-language-server)"
else
  nope "typescript-language-server not on PATH"
  note "Without it, .ts/.tsx/.js reads will not show up in the LSP panel."
  note "Install: npm install -g typescript-language-server"
  note "(or rerun ./install.sh — it auto-installs unless --no-lsp-deps is set)"
fi
note "LSPs for other languages (gopls, lua-ls, terraform-ls, clangd, …) are"
note "downloaded by opencode on first use; no setup needed here."


# ─── Privileged-command escape hatch ─────────────────────────────────────────
section "Privileged commands inside sessions"
if command -v sudo >/dev/null 2>&1; then
  ok "sudo present at $(command -v sudo)"
  note "Run 'opencode-anycli --allow-dangerously-skip-permissions' if the agent"
  note "needs to install packages, start daemons, or otherwise act as root."
  note "(Re-execs the whole session under sudo -E — one prompt, no sudoers edits.)"
else
  case "$OS_NAME" in
    Darwin) note "macOS — install sudo via the system if you need privileged commands." ;;
    Linux)  warn "sudo not on PATH — --allow-dangerously-skip-permissions cannot work." ;;
    *)      note "Unsupported OS: $OS_NAME" ;;
  esac
fi

# ─── opencode runtime state ──────────────────────────────────────────────────
# Two known startup blockers we can detect cheaply:
#   1. Files in ~/.local/share/opencode/, ~/.config/opencode-anycli/, or
#      ~/.cline/data/ that ended up owned by root after a past
#      --allow-dangerously-skip-permissions session — every later EACCES
#      write fails the user back to a "DB error" without explanation.
#   2. The opencode SQLite database itself failing PRAGMA integrity_check
#      (the "DrizzleError: Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'"
#      error users sometimes hit after a hard kill / disk-full / power loss).
# Both are recoverable via `opencode-anycli --fix` so we point at it.
section "opencode runtime state"

DIRS_TO_CHECK="$HOME/.local/share/opencode $HOME/.config/opencode-anycli $HOME/.cline/data"
BAD_OWNER_FOUND=0
for d in $DIRS_TO_CHECK; do
  [ -d "$d" ] || continue
  badcount=$(find "$d" -not -user "$USER" 2>/dev/null | wc -l)
  if [ "$badcount" -gt 0 ]; then
    nope "$badcount file(s) in $d not owned by $USER"
    BAD_OWNER_FOUND=1
  fi
done
if [ "$BAD_OWNER_FOUND" = "0" ]; then
  ok "no foreign-owned files in opencode/cline data dirs"
else
  note "Run 'opencode-anycli --fix' to reclaim with sudo chown."
fi

DB_FILE="$HOME/.local/share/opencode/opencode.db"
if [ -f "$DB_FILE" ]; then
  if ! [ -r "$DB_FILE" ] || ! [ -w "$DB_FILE" ]; then
    nope "$DB_FILE is not readable/writable by $USER"
    note "Run 'opencode-anycli --fix' to repair."
  elif command -v sqlite3 >/dev/null 2>&1; then
    DB_CHECK="$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1 | head -1)"
    if [ "$DB_CHECK" = "ok" ]; then
      ok "opencode.db integrity_check: ok"
    else
      nope "opencode.db integrity_check failed: $DB_CHECK"
      note "Run 'opencode-anycli --fix' to back up and regenerate."
    fi
  else
    warn "sqlite3 not on PATH; cannot verify $DB_FILE"
    note "Install sqlite3 ('apt install sqlite3' / 'brew install sqlite3')"
    note "to let doctor detect DB corruption."
  fi
else
  ok "opencode.db not yet created (fresh install) — will be made on first run"
fi

# ─── Smoke test ───────────────────────────────────────────────────────────────
# Skip the smoke when cline's --version check already failed: a cline that
# can't even print its own version is guaranteed to fail this test, and the
# resulting "Inspect output: /tmp/tmp.XXX" pointer just makes the user
# chase an empty file when the actual root cause (Node version, missing
# binary, etc.) is already explained in the cline section above.
section "Smoke test (cline → 'doctor ok')"
if [ "$CLINE_OK" -ne 1 ]; then
  warn "skipping (cline --version did not succeed — see cline section above)"
elif command -v cline >/dev/null 2>&1; then
  TMP_OUT="$(mktemp)"
  ( cline --json --yolo --act "say exactly: doctor ok" >"$TMP_OUT" 2>/dev/null ) &
  SMOKE_PID=$!
  WAITED=0
  while kill -0 "$SMOKE_PID" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED+1))
    if [ "$WAITED" -ge 30 ]; then
      kill "$SMOKE_PID" 2>/dev/null || true
      nope "cline timed out after 30s"
      break
    fi
  done
  wait "$SMOKE_PID" 2>/dev/null || true
  if grep -q '"completion_result"' "$TMP_OUT" 2>/dev/null || grep -q '"say":"text"' "$TMP_OUT" 2>/dev/null; then
    ok "cline returned a completion event"
  else
    nope "no completion_result in cline output"
    note "Inspect output: $TMP_OUT"
  fi
else
  warn "skipping (cline not installed)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
printf "\n"
if [ "$FAIL" -eq 0 ]; then
  printf "${GREEN}All checks passed (%d).${RESET}\n" "$PASS"
  exit 0
else
  printf "${RED}%d failures, %d passed.${RESET}\n" "$FAIL" "$PASS"
  printf "${DIM}See docs/troubleshooting.md for help.${RESET}\n"
  exit 1
fi
