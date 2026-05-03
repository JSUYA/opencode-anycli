#!/usr/bin/env bash
# install.sh — one-shot installer for openclineclicode.
# Idempotent. Safe to re-run. macOS + Linux. POSIX-friendly bash.
set -e

# ─── Color helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN="\033[1;32m"; YELLOW="\033[1;33m"; RED="\033[1;31m"; BLUE="\033[1;34m"; DIM="\033[2m"; RESET="\033[0m"
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; DIM=""; RESET=""
fi
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info()  { printf "${BLUE}ℹ${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" 1>&2; }
step()  { printf "\n${BLUE}▶${RESET} %s\n" "$*"; }

# ─── Args ─────────────────────────────────────────────────────────────────────
USER_INSTALL=0
SKIP_BUILD=0
USE_SUDO=0
NO_AUTO_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --user) USER_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --sudo) USE_SUDO=1 ;;
    --no-auto-deps) NO_AUTO_DEPS=1 ;;
    --yes|-y) ;;            # accepted for backwards-compat; auto-install is now default
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--user] [--skip-build] [--sudo] [--no-auto-deps]

  openclineclicode treats opencode + cline as bundled runtime dependencies.
  If either is missing, this installer fetches them via npm by default —
  no extra flag needed. The user-visible install is just:
      git clone … && cd … && ./install.sh

  --user           Symlink into ~/.local/bin instead of /usr/local/bin
  --skip-build     Skip the workspace build step (assumes dist/ exists)
  --sudo           Use sudo when symlinking to /usr/local/bin AND when
                   auto-installing opencode/cline globally
  --no-auto-deps   Air-gap mode: fail if opencode/cline are missing
                   instead of running 'npm install -g'
EOF
      exit 0 ;;
    *) err "Unknown arg: $arg"; exit 2 ;;
  esac
done

# ─── Helper: prompt, default-no ───────────────────────────────────────────────
ask_yes() {
  # ask_yes "<question>" - returns 0 (yes) or 1 (no). Default = no on Enter.
  # Auto-yes if --yes was passed. Auto-no if stdin is not a tty (CI).
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  printf "${YELLOW}?${RESET} %s [y/N] " "$1"
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ─── Helper: install a global npm package (opencode-ai / cline) ───────────────
auto_npm_install() {
  # auto_npm_install <pkg> <bin-name> <human-label>
  local pkg="$1" bin_name="$2" label="$3"
  if ! command -v npm >/dev/null 2>&1; then
    err "npm is required to auto-install $label but is not on PATH."
    err "  Install Node + npm first (Node 20+), then re-run this script."
    return 1
  fi
  local log_file
  log_file="$(mktemp -t openclineclicode-npm.XXXXXX)"
  info "Running: npm install -g $pkg"
  if [ "$USE_SUDO" -eq 1 ]; then
    if sudo npm install -g "$pkg"; then : ; else
      err "sudo npm install -g $pkg failed."
      rm -f "$log_file"
      return 1
    fi
  else
    if npm install -g "$pkg" 2>&1 | tee "$log_file"; then
      :
    else
      if grep -qE "EACCES|permission denied" "$log_file" 2>/dev/null; then
        warn "npm reported a permission error. Re-running with sudo..."
        if sudo npm install -g "$pkg"; then : ; else
          err "sudo npm install -g $pkg also failed."
          rm -f "$log_file"
          return 1
        fi
      else
        err "npm install -g $pkg failed (see output above)."
        rm -f "$log_file"
        return 1
      fi
    fi
  fi
  rm -f "$log_file"
  if ! command -v "$bin_name" >/dev/null 2>&1; then
    err "$label installed but $bin_name still not on PATH."
    err "  Check 'npm bin -g' and ensure that directory is in PATH."
    return 1
  fi
  ok "$label installed: $($bin_name --version 2>&1 | head -n1)"
  return 0
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── 1. Detect OS ─────────────────────────────────────────────────────────────
step "Detecting environment"
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin) ok "OS: macOS" ;;
  Linux)  ok "OS: Linux" ;;
  *) err "Unsupported OS: $OS_NAME"; exit 1 ;;
esac

# ─── 2. Node version check ────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "node not found on PATH. Install Node 20+ first."
  exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node $NODE_VER detected — Node 20+ required."
  exit 1
fi
ok "Node v$NODE_VER"

# ─── 3. opencode binary (bundled runtime — auto-installed on demand) ─────────
if command -v opencode >/dev/null 2>&1; then
  ok "opencode: $(opencode --version 2>&1 | head -n1)"
elif [ "$NO_AUTO_DEPS" -eq 1 ]; then
  err "opencode not found on PATH and --no-auto-deps was specified."
  err "  Install manually: npm install -g opencode-ai"
  exit 1
else
  step "opencode is part of openclineclicode's runtime; installing it now"
  auto_npm_install opencode-ai opencode "opencode" || exit 1
fi

# ─── 4. cline binary (bundled runtime — auto-installed on demand) ────────────
if command -v cline >/dev/null 2>&1; then
  ok "cline: $(cline --version 2>&1 | head -n1)"
elif [ "$NO_AUTO_DEPS" -eq 1 ]; then
  err "cline not found on PATH and --no-auto-deps was specified."
  err "  Install manually: npm install -g cline"
  exit 1
else
  step "cline is part of openclineclicode's runtime; installing it now"
  auto_npm_install cline cline "cline" || exit 1
fi

if [ ! -f "$HOME/.cline/data/globalState.json" ]; then
  warn "~/.cline/data/globalState.json not found; run cline once to finish setup."
fi

# ─── 5. Build the provider ────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "Building workspaces"
  cd "$REPO_DIR"
  if command -v bun >/dev/null 2>&1; then
    info "bun found; using bun install + build"
    bun install
    bun run build
  else
    info "Using npm because bun is unavailable"
    npm install --workspaces --include-workspace-root
    npm run build --workspaces --if-present
  fi
  ok "Build complete"
else
  warn "--skip-build set; skipping build."
fi

# ─── 6. Copy default config ───────────────────────────────────────────────────
# Path layout note: the wrapper sets XDG_CONFIG_HOME=$HOME/.config/openclineclicode
# at spawn time, so opencode auto-discovers commands/agents/skills under
# $HOME/.config/openclineclicode/opencode/. The opencode.json must therefore
# live one directory deeper than the wrapper's XDG dir.
step "Installing default opencode.json"
CONFIG_DIR="$HOME/.config/openclineclicode/opencode"
mkdir -p "$CONFIG_DIR"
TARGET="$CONFIG_DIR/opencode.json"
SOURCE="$REPO_DIR/templates/opencode.json"
PROVIDER_DIST="$REPO_DIR/packages/provider-cline-cli/dist/index.js"
if [ ! -f "$PROVIDER_DIST" ]; then
  err "Provider dist not found: $PROVIDER_DIST"
  err "Run ./install.sh without --skip-build to build first."
  exit 1
fi
if [ -f "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%s)"
  cp "$TARGET" "$BACKUP"
  warn "Existing config backed up: $BACKUP"
fi
# Substitute the file:// path so opencode loads the local build instead of trying npm.
# Uses '|' as sed delimiter because the path contains '/'.
sed "s|__OPENCLINECLICODE_PROVIDER_DIST__|${PROVIDER_DIST}|g" "$SOURCE" > "$TARGET"
ok "Config installed: $TARGET"
note_path() { printf "  ${DIM}↳ provider dist: %s${RESET}\n" "$*"; }
note_path "$PROVIDER_DIST"

# AGENTS.md template
AGENTS_TARGET="$CONFIG_DIR/AGENTS.md"
if [ ! -f "$AGENTS_TARGET" ]; then
  cp "$REPO_DIR/templates/AGENTS.md" "$AGENTS_TARGET"
  ok "AGENTS.md installed: $AGENTS_TARGET"
fi

# ─── 7. Symlink the CLI ───────────────────────────────────────────────────────
step "Linking openclineclicode binary"
BIN_SRC="$REPO_DIR/packages/cli/bin/openclineclicode"
chmod +x "$BIN_SRC" || true

if [ "$USER_INSTALL" -eq 1 ]; then
  TARGET_DIR="$HOME/.local/bin"
  mkdir -p "$TARGET_DIR"
  ln -sf "$BIN_SRC" "$TARGET_DIR/openclineclicode"
  ok "Linked to $TARGET_DIR/openclineclicode"
  case ":$PATH:" in
    *":$TARGET_DIR:"*) : ;;
    *) warn "$TARGET_DIR is not in PATH. Add this to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
else
  TARGET_DIR="/usr/local/bin"
  if [ -w "$TARGET_DIR" ]; then
    ln -sf "$BIN_SRC" "$TARGET_DIR/openclineclicode"
    ok "Linked to $TARGET_DIR/openclineclicode"
  elif [ "$USE_SUDO" -eq 1 ]; then
    sudo ln -sf "$BIN_SRC" "$TARGET_DIR/openclineclicode"
    ok "Linked to $TARGET_DIR/openclineclicode (sudo)"
  else
    warn "$TARGET_DIR is not writable."
    info "Re-run with ./install.sh --user or ./install.sh --sudo."
    exit 1
  fi
fi

# ─── 8. Next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}installation complete / Installation complete${RESET}

  1) Run diagnostics:        ${BLUE}openclineclicode --doctor${RESET}
  2) Start opencode:         ${BLUE}openclineclicode${RESET}
  3) Edit config:            ${BLUE}\$EDITOR $TARGET${RESET}
  4) Troubleshooting:        ${BLUE}docs/troubleshooting.md${RESET}
  5) Try passthrough later:  ${BLUE}docs/provider-modes.md${RESET}

EOF
