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

# ─── opencode ─────────────────────────────────────────────────────────────────
section "opencode"
if command -v opencode >/dev/null 2>&1; then
  OPV="$(opencode --version 2>&1 | head -n1)"
  ok "opencode found: $OPV"
  note "$(command -v opencode)"
else
  nope "opencode not on PATH"
  note "Install: npm install -g opencode-ai"
fi

# ─── cline ────────────────────────────────────────────────────────────────────
section "cline"
if command -v cline >/dev/null 2>&1; then
  CLV="$(cline --version 2>&1 | head -n1)"
  ok "cline found: $CLV"
  note "$(command -v cline)"
else
  nope "cline not on PATH"
  note "Install: npm install -g cline"
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

# ─── Smoke test ───────────────────────────────────────────────────────────────
section "Smoke test (cline → 'doctor ok')"
if command -v cline >/dev/null 2>&1; then
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
