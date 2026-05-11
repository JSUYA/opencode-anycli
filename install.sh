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
REBUILD=0
USE_SUDO=0
NO_AUTO_DEPS=0
NO_LSP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --user) USER_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --rebuild) REBUILD=1 ;;
    --sudo) USE_SUDO=1 ;;
    --no-auto-deps) NO_AUTO_DEPS=1 ;;
    --no-lsp-deps) NO_LSP_DEPS=1 ;;
    --yes|-y) ;;            # accepted for backwards-compat; auto-install is now default
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--skip-build] [--rebuild] [--no-auto-deps] [--no-lsp-deps]

  opencode-anycli treats opencode + cline as bundled runtime dependencies.
  If either is missing, this installer fetches them via npm by default —
  no extra flag needed. The user-visible install is just:
      git clone … && cd … && ./install.sh

  After build, this script appends a managed PATH-export block to your
  shell rc file (.bashrc for bash, .zshrc for zsh, config.fish for
  fish) pointing at <repo>/packages/cli/bin/. Open a new shell or
  'source' the rc file to use the 'opencode-anycli' command.

  --skip-build     Skip the workspace build step (assumes dist/ exists)
  --rebuild        Force a fresh build of every workspace, bypassing the
                   "dist already newer than src" cache check.
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
# Why this is so defensive: two npm-global failure modes silently corrupted
# previous installs.
#
#   1. `npm install -g X 2>&1 | tee LOG` returns tee's exit status, not
#      npm's, so a failing npm install slipped through every check and the
#      function reported "X installed: <old version>" because the existing
#      stale binary was still on PATH. Detected on Ubuntu 22.04 where
#      opencode 1.14.41 → 1.14.48 silently no-op'd. We now use
#      ${PIPESTATUS[0]} to read npm's exit code through the pipe.
#
#   2. npm's "atomic rename" install strategy (move new-version to a temp
#      sibling, rename old to .pkg-XXX, rename new into place) leaves the
#      install half-done when any rename trips ENOTEMPTY — typically
#      because a previous interrupted run left .pkg-XXX shadow dirs
#      behind, or because a file watcher (VS Code, opencode itself) had
#      open handles on the old version. The repair is mechanical: rm -rf
#      the package dir + every .pkg-XXX sibling under the global
#      lib/node_modules, then retry once. We only do this for the
#      no-sudo path; root-owned trees keep escalating to sudo.
#
# We also use `<pkg>@latest` for the actual install so npm cannot resolve
# from a stale dist-tag cached locally — the version floor in
# install_or_upgrade_opencode depends on this returning the newest
# published version, not whatever happens to be cached.
auto_npm_install() {
  # auto_npm_install <pkg> <bin-name> <human-label>
  local pkg="$1" bin_name="$2" label="$3"
  if ! command -v npm >/dev/null 2>&1; then
    err "npm is required to auto-install $label but is not on PATH."
    err "  Install Node + npm first (Node 20+), then re-run this script."
    return 1
  fi
  local pkg_spec="${pkg}@latest"
  local log_file
  log_file="$(mktemp -t opencode-anycli-npm.XXXXXX)"

  # Run npm and capture its real exit status through the pipe. local
  # cannot carry PIPESTATUS, so split the declaration from the assignment.
  local npm_status
  _run_npm_install() {
    local target="$1"
    if [ "$USE_SUDO" -eq 1 ]; then
      sudo npm install -g "$target" 2>&1 | tee "$log_file"
    else
      npm install -g "$target" 2>&1 | tee "$log_file"
    fi
    return "${PIPESTATUS[0]}"
  }

  info "Running: npm install -g $pkg_spec"
  _run_npm_install "$pkg_spec"
  npm_status=$?

  # ENOTEMPTY repair — only safe when we're installing into a user-owned
  # tree (no sudo). Look at the lib/node_modules dir npm itself targets;
  # nuke the package dir and every .pkg-* shadow sibling under it; retry.
  if [ "$npm_status" -ne 0 ] && [ "$USE_SUDO" -ne 1 ] \
     && grep -q "ENOTEMPTY" "$log_file" 2>/dev/null; then
    warn "npm hit ENOTEMPTY — a previous interrupted install left shadow dirs."
    local npm_prefix global_modules
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    global_modules="${npm_prefix:+$npm_prefix/lib/node_modules}"
    if [ -n "$global_modules" ] && [ -d "$global_modules" ] \
       && [ -w "$global_modules" ]; then
      info "Cleaning $global_modules/$pkg + shadow siblings, then retrying"
      rm -rf "$global_modules/$pkg" 2>/dev/null || true
      # Shadow dirs look like .opencode-ai-HJFGfa0l. Be conservative — only
      # remove ones whose suffix starts with the package basename.
      local base="${pkg##*/}"
      find "$global_modules" -maxdepth 1 -type d -name ".${base}-*" \
        -exec rm -rf {} + 2>/dev/null || true
      _run_npm_install "$pkg_spec"
      npm_status=$?
    else
      warn "  Cannot self-heal: global modules dir missing or not writable."
      warn "  Manual recovery:"
      warn "    rm -rf \"\$(npm prefix -g)/lib/node_modules/$pkg\""
      warn "    rm -rf \"\$(npm prefix -g)/lib/node_modules/.${pkg##*/}\"-*"
      warn "    npm install -g $pkg_spec"
    fi
  fi

  # EACCES repair (unchanged from before, just re-flowed against the new
  # PIPESTATUS-aware status capture).
  if [ "$npm_status" -ne 0 ] && [ "$USE_SUDO" -ne 1 ] \
     && grep -qE "EACCES|permission denied" "$log_file" 2>/dev/null; then
    warn "npm reported a permission error. Re-running with sudo..."
    sudo npm install -g "$pkg_spec" 2>&1 | tee "$log_file"
    npm_status="${PIPESTATUS[0]}"
  fi

  if [ "$npm_status" -ne 0 ]; then
    err "npm install -g $pkg_spec failed (exit $npm_status, see output above)."
    rm -f "$log_file"
    return 1
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
# Why a minimum version check lives here: opencode-anycli ships a tui.json
# (templates/tui.json) and a TUI plugin (packages/tui-plugin-exit-confirm)
# that both target opencode ≥ 1.14:
#   - Keybind names `prompt_submit`, `input_submit`, `input_newline` were
#     introduced in 1.14 alongside the strict tui.json schema
#     (`additionalProperties: false`). On older opencode these names are
#     unknown and the whole keybind override block is silently dropped, so
#     Ctrl+C falls back to default app_exit and Enter falls back to submit.
#   - The plugin intercepts Ctrl+C via `api.renderer.keyInput.on("keypress")`,
#     an API that only exists in 1.14+. On older builds the plugin loads
#     but the guard at the top short-circuits and no handler is attached.
# Additionally we have a concrete report of 1.14.41 failing to load the
# plugin even though dist/tui.json/file:// URL are all valid, with the fix
# being a bump to 1.14.48 — so the floor here is the highest known-good
# point release we've observed working, not just 1.14.0.
OPENCODE_MIN_VER="1.14.48"
opencode_version_meets_min() {
  # Returns 0 (true) if "$1" >= OPENCODE_MIN_VER under SemVer, 1 otherwise.
  # Pure-bash compare; no jq/sort -V dependency so we work the same on
  # macOS BSD coreutils and stripped-down Linux containers.
  local have="$1" need="$OPENCODE_MIN_VER"
  local IFS=.
  # shellcheck disable=SC2206
  local h=($have) n=($need)
  for i in 0 1 2; do
    local hp="${h[$i]:-0}" np="${n[$i]:-0}"
    # Strip any pre-release suffix (e.g. "48-beta.1") for the compare.
    hp="${hp%%[!0-9]*}"; np="${np%%[!0-9]*}"
    hp="${hp:-0}"; np="${np:-0}"
    if [ "$hp" -gt "$np" ]; then return 0; fi
    if [ "$hp" -lt "$np" ]; then return 1; fi
  done
  return 0
}

# Single source of truth for the install + upgrade paths so we don't drift.
install_or_upgrade_opencode() {
  if [ "$NO_AUTO_DEPS" -eq 1 ]; then
    err "opencode ≥ $OPENCODE_MIN_VER required and --no-auto-deps was specified."
    err "  Upgrade manually: npm install -g opencode-ai@latest"
    return 1
  fi
  auto_npm_install opencode-ai opencode "opencode"
}

if command -v opencode >/dev/null 2>&1; then
  current_oc_ver="$(opencode --version 2>&1 | head -n1 | sed -E 's/^v//; s/[[:space:]]+$//')"
  if opencode_version_meets_min "$current_oc_ver"; then
    ok "opencode: $current_oc_ver (≥ $OPENCODE_MIN_VER)"
  else
    warn "opencode $current_oc_ver is older than the required $OPENCODE_MIN_VER."
    warn "  Older builds silently drop our tui.json keybinds and fail to load the"
    warn "  Ctrl+C exit-confirm plugin, so the install would 'succeed' but the"
    warn "  Ctrl+C dialog and Shift+Enter newline never take effect. Upgrading…"
    install_or_upgrade_opencode || exit 1
    # Re-verify — npm could silently install something that still doesn't
    # satisfy the floor (e.g. a dist-tag pin in the registry, a sticky
    # npm cache). Bail loudly rather than continuing into a broken state.
    new_oc_ver="$(opencode --version 2>&1 | head -n1 | sed -E 's/^v//; s/[[:space:]]+$//')"
    if ! opencode_version_meets_min "$new_oc_ver"; then
      err "opencode is still $new_oc_ver after upgrade attempt (need ≥ $OPENCODE_MIN_VER)."
      err "  Try: npm install -g opencode-ai@latest"
      exit 1
    fi
    ok "opencode: $new_oc_ver"
  fi
elif [ "$NO_AUTO_DEPS" -eq 1 ]; then
  err "opencode not found on PATH and --no-auto-deps was specified."
  err "  Install manually: npm install -g opencode-ai"
  exit 1
else
  step "opencode is part of opencode-anycli's runtime; installing it now"
  install_or_upgrade_opencode || exit 1
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

# ─── 5. Build the workspaces ──────────────────────────────────────────────────
# Why this is more than a per-package mtime compare: previous versions only
# tested provider-cline-cli/dist/index.js + cli/dist/index.js against their
# matching src/index.ts. That missed packages/tui-plugin-exit-confirm
# entirely — so when a commit only touched the plugin's source (as several
# recent Ctrl+C fixes did), every other machine running ./install.sh would
# see "cli + provider dist look fresh, skip build" and silently keep the
# stale plugin dist. tui.json points opencode at a file:// URL that
# resolved fine, but the JS at that path was old → Ctrl+C dialog never
# appeared and Enter behaviour didn't update.
#
# Fix: enumerate every workspace package, and rebuild if ANY package's
# dist is missing or older than ANY file under its src/. `find -newer`
# is supported by both GNU and BSD find so this stays portable.
needs_build() {
  # Always rebuild when node_modules is gone — npm/bun won't even resolve
  # the @opencode-ai/plugin types needed to typecheck the plugin source.
  if [ ! -d "$REPO_DIR/node_modules" ]; then return 0; fi
  local pkg_dir dist_file src_dir
  # (pkg_dir|primary_dist_file) pairs. Adding a new workspace? Add it here.
  local pairs=(
    "$REPO_DIR/packages/cli|$REPO_DIR/packages/cli/dist/index.js"
    "$REPO_DIR/packages/provider-cline-cli|$REPO_DIR/packages/provider-cline-cli/dist/index.js"
    "$REPO_DIR/packages/tui-plugin-exit-confirm|$REPO_DIR/packages/tui-plugin-exit-confirm/dist/tui.js"
  )
  for pair in "${pairs[@]}"; do
    pkg_dir="${pair%|*}"
    dist_file="${pair#*|}"
    src_dir="$pkg_dir/src"
    if [ ! -f "$dist_file" ]; then return 0; fi
    if [ ! -d "$src_dir" ]; then continue; fi
    # Any source file newer than the dist → out of date. Limit to -type f
    # so we don't trip on directory mtime changes from `git checkout`.
    if find "$src_dir" -type f -newer "$dist_file" 2>/dev/null | grep -q .; then
      return 0
    fi
  done
  return 1
}

if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "--skip-build set; skipping build."
elif [ "$REBUILD" -eq 0 ] && ! needs_build; then
  step "Build artifacts already present and newer than sources across every workspace; skipping build"
  info "Pass --rebuild to force a fresh build"
else
  if [ "$REBUILD" -eq 1 ]; then
    step "Rebuilding workspaces (--rebuild)"
    # Wipe every dist/ before rebuilding so stale bundles can't survive a
    # tsup incremental-skip. Leave node_modules alone — the user can blow
    # those away separately with uninstall.sh --purge-build if needed.
    rm -rf \
      "$REPO_DIR/packages/cli/dist" \
      "$REPO_DIR/packages/provider-cline-cli/dist" \
      "$REPO_DIR/packages/tui-plugin-exit-confirm/dist"
  else
    step "Building workspaces"
  fi
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

# SOURCE_CMD: the exact one-liner the user can paste in their CURRENT shell
# to make `opencode-anycli` available without opening a new terminal. This
# is what we surface at the very end of the script so it doesn't get lost
# in the "next steps" block. We also export NEEDS_PATH_RELOAD so the final
# block knows whether to print the apply hint at all (no point if PATH was
# already correct from a previous install).
SOURCE_CMD=""
NEEDS_PATH_RELOAD=0
case "$SHELL_NAME" in
  fish) SOURCE_CMD="source $RC_FILE" ;;
  *)    SOURCE_CMD="source $RC_FILE" ;;  # bash/zsh syntax matches
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
  fi
fi

# The user only needs to source/relaunch when the CURRENT shell doesn't
# already have BIN_DIR on PATH. New shells always pick it up from the rc
# block we just wrote, so this check is purely about helping the existing
# session. Whether we appended a fresh block or matched an existing one
# is irrelevant — what matters is what the live PATH looks like RIGHT NOW.
if [ -n "$RC_FILE" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) NEEDS_PATH_RELOAD=0 ;;
    *)              NEEDS_PATH_RELOAD=1 ;;
  esac
fi

# Legacy-binary shadowing check. If a previous --sudo / --user install
# left a real `opencode-anycli` (not a symlink to BIN_DIR) at a higher-
# priority PATH location, the user's shell will keep invoking that stale
# entry instead of the freshly-built one — same symptom as a stale dist,
# but with no obvious clue from the install output. We check what
# `command -v opencode-anycli` resolves to right now (the script's PATH
# already mirrors the parent shell's at this point) and compare its real
# path against our BIN_DIR entry. Mismatch → tell the user exactly what
# to delete and where.
RESOLVED_CLI="$(command -v opencode-anycli 2>/dev/null || true)"
if [ -n "$RESOLVED_CLI" ]; then
  RESOLVED_CLI_REAL="$(readlink -f "$RESOLVED_CLI" 2>/dev/null || printf '%s' "$RESOLVED_CLI")"
  EXPECTED_CLI_REAL="$(readlink -f "$BIN_DIR/opencode-anycli" 2>/dev/null || printf '%s' "$BIN_DIR/opencode-anycli")"
  if [ "$RESOLVED_CLI_REAL" != "$EXPECTED_CLI_REAL" ]; then
    warn "PATH conflict: 'opencode-anycli' on PATH resolves to a different binary"
    note "found    : $RESOLVED_CLI"
    note "expected : $BIN_DIR/opencode-anycli"
    warn "  The shadowing entry is from a previous install. Remove it so this"
    warn "  fresh build wins on PATH (use sudo if it is root-owned):"
    note "  rm -f \"$RESOLVED_CLI\""
    warn "  Then open a new shell or 'source' your rc file."
  fi
fi

# ─── 8. Next steps ────────────────────────────────────────────────────────────
# We CAN'T modify the parent shell's environment from inside this script
# (a child process never can). So we surface the exact one-liner to apply
# the new PATH in the current shell, prominently. New terminals pick it
# up automatically — the source is only needed for the existing one.
if [ "$NEEDS_PATH_RELOAD" -eq 1 ] && [ -n "$SOURCE_CMD" ]; then
  printf "\n${YELLOW}▶ Apply the new PATH in this shell:${RESET}\n"
  printf "    ${GREEN}%s${RESET}\n" "$SOURCE_CMD"
  printf "  ${DIM}(or just open a new terminal — both work.)${RESET}\n"
fi

cat <<EOF

${GREEN}installation complete / Installation complete${RESET}

  1) Run diagnostics:        ${BLUE}opencode-anycli --doctor${RESET}
  2) Start opencode:         ${BLUE}opencode-anycli${RESET}
  3) Edit config:            ${BLUE}\$EDITOR $TARGET${RESET}
  4) Troubleshooting:        ${BLUE}docs/troubleshooting.md${RESET}
  5) Try passthrough later:  ${BLUE}docs/provider-modes.md${RESET}

EOF
