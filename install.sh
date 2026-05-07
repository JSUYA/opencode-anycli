#!/usr/bin/env bash
# install.sh — one-shot installer for opencode-anycli.
# Idempotent. Safe to re-run. macOS + Linux. POSIX-friendly bash.
set -e

# ─── Color helpers ────────────────────────────────────────────────────────────
# Use $'...' literals so the escape bytes are baked into the variable at
# definition time. This way ${GREEN} expands correctly inside cat <<EOF,
# echo, and printf uniformly. Raw "\033[..." strings would only render
# correctly via printf and would print as literal text from heredocs / echo.
if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; BLUE=$'\033[1;34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; DIM=""; RESET=""
fi
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info()  { printf "${BLUE}ℹ${RESET} %s\n" "$*"; }
note()  { printf "  ${DIM}↳ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" 1>&2; }
step()  { printf "\n${BLUE}▶${RESET} %s\n" "$*"; }

# ─── Args ─────────────────────────────────────────────────────────────────────
USER_INSTALL=0
SKIP_BUILD=0
USE_SUDO=0
NO_AUTO_DEPS=0
NO_LSP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --user) USER_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --sudo) USE_SUDO=1 ;;
    --no-auto-deps) NO_AUTO_DEPS=1 ;;
    --no-lsp-deps) NO_LSP_DEPS=1 ;;
    --yes|-y) ;;            # accepted for backwards-compat; auto-install is now default
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--skip-build] [--no-auto-deps] [--no-lsp-deps]

  opencode-anycli treats opencode + cline as bundled runtime dependencies.
  If either is missing, this installer fetches them via npm by default —
  no extra flag needed. The user-visible install is just:
      git clone … && cd … && ./install.sh

  After build, this script appends a managed PATH-export block to your
  shell rc file (.bashrc for bash, .zshrc for zsh, config.fish for
  fish) pointing at <repo>/packages/cli/bin/. Open a new shell or
  'source' the rc file to use the 'opencode-anycli' command.

  --skip-build     Skip the workspace build step (assumes dist/ exists)
  --no-auto-deps   Air-gap mode: fail if opencode/cline are missing
                   instead of running 'npm install -g'
  --no-lsp-deps    Skip auto-install of typescript-language-server.
                   The right-hand "LSP" panel will stay empty for .ts/.tsx/.js
                   files until you install it yourself. Other languages'
                   LSPs (gopls, lua-ls, etc.) are unaffected — opencode
                   downloads or installs those on first use.
  --user           DEPRECATED no-op (kept for backward compat with
                   `opencode-anycli --update --user`).
  --sudo           DEPRECATED no-op (was for /usr/local/bin symlink;
                   the PATH-based install never needs sudo).
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
  log_file="$(mktemp -t opencode-anycli-npm.XXXXXX)"
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
  step "opencode is part of opencode-anycli's runtime; installing it now"
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
  step "cline is part of opencode-anycli's runtime; installing it now"
  auto_npm_install cline cline "cline" || exit 1
fi

if [ ! -f "$HOME/.cline/data/globalState.json" ]; then
  warn "~/.cline/data/globalState.json not found; run cline once to finish setup."
fi

# ─── 4b. typescript-language-server (powers the right-hand LSP panel) ────────
# Why this is here: opencode's read-tool pipeline calls LSP.touchFile(path)
# every time a file is opened by the agent, which is what populates the
# right-hand "LSP" panel ("LSPs will activate as files are read"). For most
# languages opencode auto-downloads the server binary on first use (gopls,
# lua-ls, terraform-ls, clangd, etc.), but the TypeScript LSP is special:
# it spawns `typescript-language-server` from PATH and silently does
# nothing if the binary is missing. Since this wrapper's primary userbase
# tends to work in TS/JS repos, we install it here by default.
#
# Skip with `--no-lsp-deps` (or pass `--no-auto-deps` to refuse all
# network-fetched runtime deps).
step "typescript-language-server (LSP server for .ts/.tsx/.js)"
if [ "$NO_LSP_DEPS" -eq 1 ] || [ "$NO_AUTO_DEPS" -eq 1 ]; then
  warn "Skipping typescript-language-server install (--no-lsp-deps / --no-auto-deps)."
  warn "  The right-hand LSP panel will stay empty until you install it manually."
elif command -v typescript-language-server >/dev/null 2>&1; then
  ok "typescript-language-server: $(typescript-language-server --version 2>&1 | head -n1)"
else
  info "typescript-language-server is what makes the right-hand LSP panel populate"
  info "for .ts/.tsx/.js files; installing it now."
  auto_npm_install typescript-language-server typescript-language-server "typescript-language-server" || \
    warn "typescript-language-server install failed; LSP panel for TS/JS will stay empty."
fi

# ─── 5. Build the provider ────────────────────────────────────────────────────
PROVIDER_DIST_CHECK="$REPO_DIR/packages/provider-cline-cli/dist/index.js"
CLI_DIST_CHECK="$REPO_DIR/packages/cli/dist/index.js"
if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "--skip-build set; skipping build."
elif [ -f "$PROVIDER_DIST_CHECK" ] && [ -f "$CLI_DIST_CHECK" ] \
     && [ -d "$REPO_DIR/node_modules" ] \
     && [ "$PROVIDER_DIST_CHECK" -nt "$REPO_DIR/packages/provider-cline-cli/src/index.ts" ] \
     && [ "$CLI_DIST_CHECK" -nt "$REPO_DIR/packages/cli/src/index.ts" ]; then
  step "Build artifacts already present and newer than sources; skipping build"
  info "Pass --rebuild to force a rebuild (not yet implemented; remove dist/ + node_modules/ to force)"
else
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
fi

# ─── 6. Copy default config ───────────────────────────────────────────────────
# Path layout note: the wrapper sets XDG_CONFIG_HOME=$HOME/.config/opencode-anycli
# at spawn time, so opencode auto-discovers commands/agents/skills under
# $HOME/.config/opencode-anycli/opencode/. The opencode.json must therefore
# live one directory deeper than the wrapper's XDG dir.
step "Installing default opencode.json"
CONFIG_DIR="$HOME/.config/opencode-anycli/opencode"
mkdir -p "$CONFIG_DIR"
TARGET="$CONFIG_DIR/opencode.json"
SOURCE="$REPO_DIR/templates/opencode.json"
PROVIDER_DIST="$REPO_DIR/packages/provider-cline-cli/dist/index.js"
if [ ! -f "$PROVIDER_DIST" ]; then
  err "Provider dist not found: $PROVIDER_DIST"
  err "Run ./install.sh without --skip-build to build first."
  exit 1
fi
note_path() { printf "  ${DIM}↳ provider dist: %s${RESET}\n" "$*"; }
# Idempotent: if the existing config already substitutes to the current
# PROVIDER_DIST path, skip the write entirely (no .bak file proliferation).
# Compare against what we would have written.
EXPECTED="$(sed "s|__OPENCODE_ANYCLI_PROVIDER_DIST__|${PROVIDER_DIST}|g" "$SOURCE")"
if [ -f "$TARGET" ] && [ "$(cat "$TARGET")" = "$EXPECTED" ]; then
  ok "Config already up-to-date: $TARGET"
  note_path "$PROVIDER_DIST"
else
  if [ -f "$TARGET" ]; then
    BACKUP="$TARGET.bak.$(date +%s)"
    cp "$TARGET" "$BACKUP"
    warn "Existing config differs; previous version backed up: $BACKUP"
  fi
  printf '%s\n' "$EXPECTED" > "$TARGET"
  ok "Config installed: $TARGET"
  note_path "$PROVIDER_DIST"
fi

# AGENTS.md template
AGENTS_TARGET="$CONFIG_DIR/AGENTS.md"
if [ ! -f "$AGENTS_TARGET" ]; then
  cp "$REPO_DIR/templates/AGENTS.md" "$AGENTS_TARGET"
  ok "AGENTS.md installed: $AGENTS_TARGET"
fi

# tui.json — opencode reads this for keybind / plugin overrides. We ship one
# that (1) removes ctrl+c from the `app_exit` keybind so the component-level
# exit-on-Ctrl+C handlers stop firing, and (2) registers our exit-confirm
# TUI plugin via the file:// URL of its built directory. The plugin shows a
# DialogConfirm before actually running app.exit. The path is materialised
# from a placeholder so a relocated repo still works.
TUI_TARGET="$CONFIG_DIR/tui.json"
TUI_SOURCE="$REPO_DIR/templates/tui.json"
EXIT_CONFIRM_DIR="$REPO_DIR/packages/tui-plugin-exit-confirm"
if [ ! -f "$EXIT_CONFIRM_DIR/dist/tui.js" ]; then
  err "Exit-confirm plugin dist not found at $EXIT_CONFIRM_DIR/dist/tui.js"
  err "Run ./install.sh without --skip-build to build first."
  exit 1
fi
TUI_EXPECTED="$(sed "s|__OPENCODE_ANYCLI_EXIT_CONFIRM_DIR__|${EXIT_CONFIRM_DIR}|g" "$TUI_SOURCE")"
if [ -f "$TUI_TARGET" ] && [ "$(cat "$TUI_TARGET")" = "$TUI_EXPECTED" ]; then
  ok "tui.json already up-to-date: $TUI_TARGET"
elif [ -f "$TUI_TARGET" ]; then
  BACKUP="$TUI_TARGET.bak.$(date +%s)"
  cp "$TUI_TARGET" "$BACKUP"
  warn "Existing tui.json differs; previous version backed up: $BACKUP"
  printf '%s\n' "$TUI_EXPECTED" > "$TUI_TARGET"
  ok "tui.json installed: $TUI_TARGET"
else
  printf '%s\n' "$TUI_EXPECTED" > "$TUI_TARGET"
  ok "tui.json installed: $TUI_TARGET"
fi

# ─── 7. Add the CLI's bin directory to your shell PATH ───────────────────────
# We deliberately do NOT symlink into /usr/local/bin or ~/.local/bin anymore.
# Instead we append a managed `export PATH=...` block to the user's shell rc
# (.bashrc / .zshrc / fish config), pointing at this checkout's bin dir. That
# means:
#   - upgrades via `git pull` / --update take effect immediately, no relink.
#   - moving / deleting the repo cleanly removes the binary from PATH.
#   - no sudo is ever needed for the link step itself.
# We use BEGIN/END markers so we can detect and update the block in place
# when the repo is relocated, without leaving a duplicate behind.
step "Adding opencode-anycli to your shell PATH"
BIN_DIR="$REPO_DIR/packages/cli/bin"
chmod +x "$BIN_DIR/opencode-anycli" || true

# --user / --sudo predate the PATH-based install. They used to choose
# ~/.local/bin vs /usr/local/bin for the symlink target. Both are now
# meaningless — keep them silently so existing wrappers like
# `opencode-anycli --update --user` don't break, but warn once.
if [ "$USER_INSTALL" -eq 1 ] || [ "$USE_SUDO" -eq 1 ]; then
  note "(--user / --sudo are no-ops with the new PATH-based install; ignoring)"
fi

# Detect the user's interactive shell. SHELL is set by login; fall back to
# /bin/bash so a missing/empty SHELL still yields a sensible default.
SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
case "$SHELL_NAME" in
  bash)
    RC_FILE="$HOME/.bashrc"
    EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
    ;;
  zsh)
    RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"
    EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
    ;;
  fish)
    RC_FILE="$HOME/.config/fish/config.fish"
    # fish_add_path is idempotent at runtime AND survives reordering, but
    # we still wrap it in our managed block so we can remove cleanly.
    EXPORT_LINE="fish_add_path \"$BIN_DIR\""
    ;;
  *)
    warn "Could not auto-configure PATH for shell '$SHELL_NAME'."
    note "Add this line to your shell init manually:"
    note "  export PATH=\"$BIN_DIR:\$PATH\""
    RC_FILE=""
    ;;
esac

if [ -n "$RC_FILE" ]; then
  MARKER_BEGIN="# >>> opencode-anycli (managed by install.sh) >>>"
  MARKER_END="# <<< opencode-anycli (managed by install.sh) <<<"
  mkdir -p "$(dirname "$RC_FILE")"
  touch "$RC_FILE"

  # Read the current managed block (if any) without invoking grep with a
  # pattern that contains regex metachars from the marker text.
  current_block="$(awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      $0 == b { inside = 1; next }
      $0 == e { inside = 0; next }
      inside  { print }
    ' "$RC_FILE")"
  expected_block="$EXPORT_LINE"

  if [ "$current_block" = "$expected_block" ]; then
    ok "PATH entry already in $RC_FILE (no change needed)"
  else
    if [ -n "$current_block" ]; then
      # Block exists but content differs — most often the repo was moved.
      # Strip the old block, then append a fresh one.
      tmp_rc="$(mktemp)"
      awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
        $0 == b { inside = 1; next }
        $0 == e { inside = 0; next }
        !inside { print }
      ' "$RC_FILE" > "$tmp_rc"
      mv "$tmp_rc" "$RC_FILE"
      info "Replaced existing managed block in $RC_FILE (path changed)"
    fi
    # Ensure trailing newline before our block so we don't accidentally
    # append onto the previous line.
    if [ -s "$RC_FILE" ] && [ "$(tail -c1 "$RC_FILE" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$RC_FILE"
    fi
    {
      printf '\n%s\n%s\n%s\n' "$MARKER_BEGIN" "$EXPORT_LINE" "$MARKER_END"
    } >> "$RC_FILE"
    ok "Appended PATH entry to $RC_FILE"
    note "Run 'source $RC_FILE' or open a new shell so 'opencode-anycli'"
    note "becomes available on PATH."
  fi
fi

# ─── 8. Next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}installation complete / Installation complete${RESET}

  1) Run diagnostics:        ${BLUE}opencode-anycli --doctor${RESET}
  2) Start opencode:         ${BLUE}opencode-anycli${RESET}
  3) Edit config:            ${BLUE}\$EDITOR $TARGET${RESET}
  4) Troubleshooting:        ${BLUE}docs/troubleshooting.md${RESET}
  5) Try passthrough later:  ${BLUE}docs/provider-modes.md${RESET}

EOF
