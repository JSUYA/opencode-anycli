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
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --user) USER_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --rebuild) REBUILD=1 ;;
    --sudo) USE_SUDO=1 ;;
    --no-auto-deps) NO_AUTO_DEPS=1 ;;
    --no-lsp-deps) NO_LSP_DEPS=1 ;;
    --yes|-y) ASSUME_YES=1 ;; # accepted for backwards-compat; auto-install is now default
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--skip-build] [--rebuild] [--no-auto-deps] [--no-lsp-deps]

  opencode-anycli treats opencode + cline as bundled runtime dependencies.
  If either is missing, this installer fetches them via npm by default —
  no extra flag needed. The user-visible install is just:
      git clone … && cd … && ./install.sh

  After build, this script runs 'npm link' from packages/cli/ to symlink
  the 'opencode-anycli' binary into your active Node's global bin dir
  (e.g. ~/.nvm/versions/node/<ver>/bin/opencode-anycli). That directory
  is already on PATH for any working Node install — no shell rc edit is
  required, no 'source ~/.bashrc' step.

  Any legacy 'export PATH=…' block previously appended to your shell rc
  files by an older install is removed automatically.

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
                   The installer deep-merges template defaults into the
                   existing opencode.json / tui.json so user edits survive a
                   re-install. To reset owned keys back to the bundled
                   template, delete the file and re-run install.sh.
  --user           DEPRECATED no-op (kept for backward compat with
                   `opencode-anycli --update --user`).
  --sudo           DEPRECATED but still functional: forces 'sudo' wrapping
                   on the opencode/cline/tsls auto-install steps. Has no
                   effect on the npm link step itself — that one auto-
                   retries with sudo only on EACCES.
EOF
      exit 0 ;;
    *) err "Unknown arg: $arg"; exit 2 ;;
  esac
done

# ─── Helper: deep-merge JSON ─────────────────────────────────────────────────
# Used to install opencode.json / tui.json without clobbering user keys.
#
# Computes `template * existing` (recursive merge, existing wins for shared
# keys). Template-only keys are added; existing-only keys (e.g. user-added
# `plugin[]`, extra agents installed by oh-my-anycli, manually overridden
# provider options) are preserved.
#
# Recovery: to reset owned keys back to the bundled template, delete the
# target file and re-run install.sh — the no-target branch writes a fresh
# template copy.
#
# jq is preferred. node fallback exists because opencode-anycli already
# requires Node 20+ as a hard prerequisite, so it is universally available
# even on systems missing jq.
oc_json_merge() {
  # oc_json_merge <existing-file> <template-content>
  local existing="$1" template_content="$2"
  local tmpl_file
  tmpl_file="$(mktemp)"
  printf '%s' "$template_content" > "$tmpl_file"
  local rc=0
  if command -v jq >/dev/null 2>&1; then
    jq -s '
      def merge_enabled_providers($tmpl; $existing):
        if (($tmpl.enabled_providers // null) | type) == "array" then
          ($tmpl.enabled_providers
            + (($existing.enabled_providers // [])
              | map(select(. as $p | ($tmpl.enabled_providers | index($p) | not)))))
        else
          null
        end;
      def migrate_legacy_cline_default($tmpl):
        (if has("model") and .model == "cline/default" then .model = "cline/GaussO4.1" else . end)
        | (if has("small_model") and .small_model == "cline/default" then .small_model = "cline/GaussO4.1" else . end)
        | (if (.agent? | type) == "object" then
            .agent |= with_entries(
              if (.value | type) == "object" and .value.model == "cline/default" then
                .value.model = "cline/GaussO4.1"
              else
                .
              end
            )
          else
            .
          end)
        | (if (($tmpl.provider.cline.models.default // null) == null)
              and (.provider.cline.models.default.name? == "Cline default (auto-detect from cline config)") then
            del(.provider.cline.models.default)
          else
            .
          end);
      .[0] as $T
      | .[1] as $E
      | ($T * $E)
      | (merge_enabled_providers($T; $E) as $enabled
          | if $enabled != null then .enabled_providers = $enabled else . end)
      | migrate_legacy_cline_default($T)
    ' "$tmpl_file" "$existing" || rc=$?
  else
    node -e '
      const fs=require("fs");
      const [e,t]=process.argv.slice(1);
      const E=JSON.parse(fs.readFileSync(e,"utf8"));
      const T=JSON.parse(fs.readFileSync(t,"utf8"));
      function m(a,b){
        if(a&&typeof a==="object"&&!Array.isArray(a)&&b&&typeof b==="object"&&!Array.isArray(b)){
          const o={...a};
          for(const k of Object.keys(b)) o[k]=(k in a)?m(a[k],b[k]):b[k];
          return o;
        }
        return b;
      }
      function mergeEnabledProviders(out,t,e){
        if(!Array.isArray(t.enabled_providers)) return out;
        const seen=new Set();
        const values=[...t.enabled_providers,...(Array.isArray(e.enabled_providers)?e.enabled_providers:[])];
        out.enabled_providers=values.filter((v)=>!seen.has(v)&&seen.add(v));
        return out;
      }
      function migrateLegacyClineDefault(out,t){
        const legacy="cline/default";
        const next="cline/GaussO4.1";
        if(out.model===legacy) out.model=next;
        if(out.small_model===legacy) out.small_model=next;
        if(out.agent&&typeof out.agent==="object"&&!Array.isArray(out.agent)){
          for(const value of Object.values(out.agent)){
            if(value&&typeof value==="object"&&!Array.isArray(value)&&value.model===legacy) value.model=next;
          }
        }
        const models=out.provider?.cline?.models;
        const templateDefault=t.provider?.cline?.models?.default;
        if(templateDefault===undefined&&models?.default?.name==="Cline default (auto-detect from cline config)") delete models.default;
        return out;
      }
      process.stdout.write(JSON.stringify(migrateLegacyClineDefault(mergeEnabledProviders(m(T,E),T,E),T),null,2)+"\n");
    ' "$existing" "$tmpl_file" || rc=$?
  fi
  rm -f "$tmpl_file"
  return $rc
}

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
# Why a minimum version check lives here: opencode-anycli ships a TUI plugin
# (packages/tui-plugin-exit-confirm) that intercepts Ctrl+C via
# `api.renderer.keyInput.on("keypress")`, an API that only exists in 1.14+.
# On older builds the plugin loads but the guard at the top short-circuits
# and no handler is attached, so Ctrl+C falls back to opencode's default
# `app_exit` behavior with no confirmation dialog.
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
# cline 0.5.1 is the first release that works correctly with opencode-anycli.
# Earlier versions miss critical API surface (JSON output flags, --yolo mode
# stability) that the provider-cline-cli bridge depends on at runtime.
CLINE_MIN_VER="0.5.1"
cline_version_meets_min() {
  # Returns 0 (true) if "$1" >= CLINE_MIN_VER under SemVer, 1 otherwise.
  local have="$1" need="$CLINE_MIN_VER"
  local IFS=.
  # shellcheck disable=SC2206
  local h=($have) n=($need)
  for i in 0 1 2; do
    local hp="${h[$i]:-0}" np="${n[$i]:-0}"
    hp="${hp%%[!0-9]*}"; np="${np%%[!0-9]*}"
    hp="${hp:-0}"; np="${np:-0}"
    if [ "$hp" -gt "$np" ]; then return 0; fi
    if [ "$hp" -lt "$np" ]; then return 1; fi
  done
  return 0
}

install_or_upgrade_cline() {
  if [ "$NO_AUTO_DEPS" -eq 1 ]; then
    err "cline ≥ $CLINE_MIN_VER required and --no-auto-deps was specified."
    err "  Upgrade manually: npm install -g cline@latest"
    return 1
  fi
  auto_npm_install cline cline "cline"
}

if command -v cline >/dev/null 2>&1; then
  current_cline_ver="$(cline --version 2>&1 | head -n1 | sed -E 's/^v//; s/[[:space:]]+$//')"
  if cline_version_meets_min "$current_cline_ver"; then
    ok "cline: $current_cline_ver (≥ $CLINE_MIN_VER)"
  else
    warn "cline $current_cline_ver is older than the required $CLINE_MIN_VER."
    warn "  Versions before $CLINE_MIN_VER lack the JSON output and --yolo flags"
    warn "  that opencode-anycli's provider bridge relies on. Upgrading…"
    install_or_upgrade_cline || exit 1
    new_cline_ver="$(cline --version 2>&1 | head -n1 | sed -E 's/^v//; s/[[:space:]]+$//')"
    if ! cline_version_meets_min "$new_cline_ver"; then
      err "cline is still $new_cline_ver after upgrade attempt (need ≥ $CLINE_MIN_VER)."
      err "  Try: npm install -g cline@latest"
      exit 1
    fi
    ok "cline: $new_cline_ver"
  fi
elif [ "$NO_AUTO_DEPS" -eq 1 ]; then
  err "cline not found on PATH and --no-auto-deps was specified."
  err "  Install manually: npm install -g cline"
  exit 1
else
  step "cline is part of opencode-anycli's runtime; installing it now"
  install_or_upgrade_cline || exit 1
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
EXPECTED="$(sed "s|__OPENCODE_ANYCLI_PROVIDER_DIST__|${PROVIDER_DIST}|g" "$SOURCE")"
# Non-destructive install: deep-merge the template's owned keys into any
# existing opencode.json so user-added entries (custom `plugin[]` written by
# oh-my-anycli's plugin registration, extra agent definitions, manually
# overridden provider options) survive a re-install. To reset owned keys to
# the bundled template, delete this file and re-run install.sh.
if [ ! -f "$TARGET" ]; then
  printf '%s\n' "$EXPECTED" > "$TARGET"
  ok "Config installed: $TARGET"
  note_path "$PROVIDER_DIST"
else
  if ! MERGED="$(oc_json_merge "$TARGET" "$EXPECTED")"; then
    err "Failed to merge $SOURCE into $TARGET"
    err "  Install jq or check Node availability, then retry."
    exit 1
  fi
  if [ "$(cat "$TARGET")" = "$MERGED" ]; then
    ok "Config already up-to-date: $TARGET"
    note_path "$PROVIDER_DIST"
  else
    BACKUP="$TARGET.bak.$(date +%s)"
    cp "$TARGET" "$BACKUP"
    warn "Existing config differs; previous version backed up: $BACKUP"
    printf '%s\n' "$MERGED" > "$TARGET"
    ok "Config merged (preserved user keys): $TARGET"
    note_path "$PROVIDER_DIST"
  fi
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
# Same deep-merge semantics as opencode.json. tui.json typically only has
# template-owned keys today, but the merge keeps additional user-added
# keybinds / plugin entries from being wiped on re-install.
if [ ! -f "$TUI_TARGET" ]; then
  printf '%s\n' "$TUI_EXPECTED" > "$TUI_TARGET"
  ok "tui.json installed: $TUI_TARGET"
else
  if ! TUI_MERGED="$(oc_json_merge "$TUI_TARGET" "$TUI_EXPECTED")"; then
    err "Failed to merge $TUI_SOURCE into $TUI_TARGET"
    exit 1
  fi
  if [ "$(cat "$TUI_TARGET")" = "$TUI_MERGED" ]; then
    ok "tui.json already up-to-date: $TUI_TARGET"
  else
    BACKUP="$TUI_TARGET.bak.$(date +%s)"
    cp "$TUI_TARGET" "$BACKUP"
    warn "Existing tui.json differs; previous version backed up: $BACKUP"
    printf '%s\n' "$TUI_MERGED" > "$TUI_TARGET"
    ok "tui.json merged (preserved user keys): $TUI_TARGET"
  fi
fi

# ─── 7. Symlink the CLI binary via `npm link` ────────────────────────────────
# We use `npm link` from packages/cli/ instead of appending a managed
# `export PATH=…` block to ~/.bashrc / ~/.zshrc / config.fish. npm creates
# a symlink under the active Node's global bin dir (e.g.
# /home/<user>/.nvm/versions/node/<ver>/bin/opencode-anycli), which is
# already on PATH for any working Node install. Benefits over the rc-edit:
#   - no shell rc edit required, no `source ~/.bashrc` step
#   - the same toolchain that installs opencode/cline manages our binary,
#     so nvm users get the link in the currently-active node version
#   - `npm unlink -g opencode-anycli` cleanly reverses it
#   - upgrades via `git pull` / --update take effect immediately because
#     the symlink target is the in-repo packages/cli/bin/ entry point
#
# Legacy cleanup: previous installs appended a managed `export PATH=…`
# block to the user's rc file(s). Strip them on every run so a stale
# entry pointing at this checkout doesn't shadow / duplicate the npm
# link symlink.
BIN_DIR="$REPO_DIR/packages/cli/bin"
chmod +x "$BIN_DIR/opencode-anycli" || true

step "Removing legacy managed PATH block(s) from shell rc files (if any)"
LEGACY_MARKER_BEGIN="# >>> opencode-anycli (managed by install.sh) >>>"
LEGACY_MARKER_END="# <<< opencode-anycli (managed by install.sh) <<<"
LEGACY_RC_FILES=("$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.config/fish/config.fish")
LEGACY_FOUND=0
for rc in "${LEGACY_RC_FILES[@]}"; do
  if [ ! -f "$rc" ]; then continue; fi
  if ! grep -qF "$LEGACY_MARKER_BEGIN" "$rc"; then continue; fi
  tmp_rc="$(mktemp)"
  awk -v b="$LEGACY_MARKER_BEGIN" -v e="$LEGACY_MARKER_END" '
    $0 == b { inside = 1; next }
    $0 == e { inside = 0; next }
    !inside { print }
  ' "$rc" > "$tmp_rc"
  mv "$tmp_rc" "$rc"
  ok "removed legacy managed PATH block from $rc (replaced by npm link)"
  LEGACY_FOUND=1
done
if [ "$LEGACY_FOUND" -eq 0 ]; then
  info "no legacy PATH blocks to clean up"
fi

# --user / --sudo predate the npm-link install. --user used to choose
# ~/.local/bin vs /usr/local/bin for the symlink target and is now a
# true no-op. --sudo still forces auto_npm_install (opencode/cline/tsls)
# under sudo — printed earlier in this run; the npm link step ignores it
# and only escalates on EACCES.
if [ "$USER_INSTALL" -eq 1 ]; then
  note "(--user is a no-op with the npm-link install; ignoring)"
fi
if [ "$USE_SUDO" -eq 1 ]; then
  note "(--sudo only affected the opencode/cline auto-install steps above;"
  note " npm link does not use it unless it hits EACCES.)"
fi

step "Linking the CLI via 'npm link'"
if ! command -v npm >/dev/null 2>&1; then
  err "npm is required for the npm-link install but is not on PATH."
  err "  Install Node 20+ (which bundles npm), then re-run ./install.sh."
  exit 1
fi

# Where will npm drop the bin symlink? Used both for the success
# message and the PATH-on-shell check below.
NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
if [ -z "$NPM_PREFIX" ]; then
  err "npm prefix -g returned nothing — your npm install looks broken."
  exit 1
fi
NPM_GLOBAL_BIN="$NPM_PREFIX/bin"
TARGET_LINK="$NPM_GLOBAL_BIN/opencode-anycli"

# `npm link` from packages/cli/ creates two symlinks:
#   1) $NPM_PREFIX/lib/node_modules/opencode-anycli  -> packages/cli
#   2) $NPM_GLOBAL_BIN/opencode-anycli                -> ../lib/node_modules/opencode-anycli/bin/opencode-anycli
# The walk-up template resolver inside cli/src/config.ts follows the
# real path, so it finds templates/ + packages/provider-cline-cli/dist
# without any extra resolution logic.
link_log="$(mktemp -t opencode-anycli-npm-link.XXXXXX)"
link_status=0
(
  cd "$REPO_DIR/packages/cli"
  npm link 2>&1
) | tee "$link_log"
link_status="${PIPESTATUS[0]}"

# EACCES recovery: a root-owned global node_modules tree (typical of
# plain /usr/local Node installs) needs sudo for `npm link`. nvm users
# never hit this. We retry with sudo only when the failure log clearly
# blames permissions, so accidental non-permission failures still
# bubble up instead of being silently masked.
if [ "$link_status" -ne 0 ] \
   && grep -qE "EACCES|permission denied" "$link_log" 2>/dev/null; then
  warn "npm link failed with a permission error against $NPM_PREFIX."
  warn "  This usually means the global node_modules tree is root-owned."
  warn "  Retrying with sudo…"
  ( cd "$REPO_DIR/packages/cli" && sudo npm link ) && link_status=0 || link_status=$?
fi
rm -f "$link_log"

if [ "$link_status" -ne 0 ]; then
  err "npm link failed (exit $link_status). See output above."
  err "  Manual recovery: cd $REPO_DIR/packages/cli && npm link"
  exit 1
fi

if [ ! -L "$TARGET_LINK" ] && [ ! -e "$TARGET_LINK" ]; then
  err "npm link returned 0 but $TARGET_LINK is missing."
  err "  Check 'npm prefix -g' and your Node/nvm setup."
  exit 1
fi
ok "Linked: $TARGET_LINK"
note "→ $BIN_DIR/opencode-anycli"

# PATH-shadowing check: ask the shell what `opencode-anycli` resolves to
# RIGHT NOW and compare against the npm-link symlink we just created.
# Most common cause of a mismatch: a root-owned legacy binary in
# /usr/local/bin or ~/.local/bin from a pre-PATH-block install scheme
# that still sits ahead of $(npm prefix -g)/bin on PATH. The earlier
# version of this guard compared readlink-of-symlink against
# readlink-of-symlink-target and so could never trip — keep it pointed
# at command -v output so it actually catches shadowing.
RESOLVED_CLI="$(command -v opencode-anycli 2>/dev/null || true)"
if [ -n "$RESOLVED_CLI" ]; then
  RESOLVED_CLI_REAL="$(readlink -f "$RESOLVED_CLI" 2>/dev/null || printf '%s' "$RESOLVED_CLI")"
  EXPECTED_CLI_REAL="$(readlink -f "$TARGET_LINK" 2>/dev/null || printf '%s' "$TARGET_LINK")"
  if [ "$RESOLVED_CLI_REAL" != "$EXPECTED_CLI_REAL" ]; then
    warn "PATH conflict: 'opencode-anycli' on PATH resolves to a different binary"
    note "found    : $RESOLVED_CLI"
    note "expected : $TARGET_LINK"
    warn "  A legacy install is shadowing the npm-link symlink. Remove it"
    warn "  (use sudo if root-owned) so the new link wins, then re-hash:"
    note "    rm -f \"$RESOLVED_CLI\""
    note "    hash -r   # or open a new shell"
  fi
fi

# Ensure npm's global bin dir is on PATH. With nvm this is normally set up
# already; with a custom prefix it may be missing. If absent, auto-append a
# managed block to the active shell's rc file so the user doesn't have to.
PATH_MARKER_BEGIN="# >>> opencode-anycli PATH (managed by install.sh) >>>"
PATH_MARKER_END="# <<< opencode-anycli PATH (managed by install.sh) <<<"
PATH_EXPORT_LINE="export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""

_add_path_to_rc() {
  local rc="$1"
  # Already managed by us → skip (idempotent)
  if grep -qF "$PATH_MARKER_BEGIN" "$rc" 2>/dev/null; then
    return
  fi
  printf '\n%s\n%s\n%s\n' \
    "$PATH_MARKER_BEGIN" \
    "$PATH_EXPORT_LINE" \
    "$PATH_MARKER_END" >> "$rc"
  ok "Added PATH entry to $rc"
  note "  Run: source $rc   (or open a new shell)"
}

case ":$PATH:" in
  *":$NPM_GLOBAL_BIN:"*)
    : ;;  # already on PATH — nothing to do
  *)
    warn "$NPM_GLOBAL_BIN is not on your PATH. Auto-adding to shell rc file(s)."
    # Determine target rc file(s): prefer the shell currently running install.sh,
    # then fall back to any rc files that exist.
    _patched=0
    _shell_rc=""
    case "${SHELL:-}" in
      */zsh)  _shell_rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      */bash) _shell_rc="$HOME/.bashrc" ;;
      */fish) _shell_rc="$HOME/.config/fish/config.fish" ;;
    esac
    if [ -n "$_shell_rc" ]; then
      touch "$_shell_rc"
      _add_path_to_rc "$_shell_rc"
      _patched=1
    fi
    # Also patch other rc files that exist (handles multi-shell setups)
    for _rc in "$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.config/fish/config.fish"; do
      [ "$_rc" = "$_shell_rc" ] && continue
      [ -f "$_rc" ] || continue
      _add_path_to_rc "$_rc"
      _patched=1
    done
    if [ "$_patched" -eq 0 ]; then
      warn "Could not detect a shell rc file. Add manually:"
      note "  $PATH_EXPORT_LINE"
    fi
    ;;
esac

# ─── 8. Next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}installation complete / Installation complete${RESET}

  1) Run diagnostics:        ${BLUE}opencode-anycli --doctor${RESET}
  2) Start opencode:         ${BLUE}opencode-anycli${RESET}
  3) Edit config:            ${BLUE}\$EDITOR $TARGET${RESET}
  4) Troubleshooting:        ${BLUE}docs/troubleshooting.md${RESET}
  5) Try passthrough later:  ${BLUE}docs/provider-modes.md${RESET}

EOF
