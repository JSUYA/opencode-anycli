#!/usr/bin/env bash
# uninstall.sh — remove what install.sh placed on this machine.
#
# What this removes:
#   1. The `opencode-anycli` symlink in /usr/local/bin or ~/.local/bin
#   2. Optionally: ~/.config/opencode-anycli/ (the wrapper's XDG home,
#      including opencode.json + AGENTS.md + any .bak backups + anything
#      oh-my-anycli installed under it). Default behaviour KEEPS the
#      config so a re-install can restore it; pass --purge-config to remove.
#   3. Optionally: dist/ + node_modules/ inside this repo (the build).
#      Default keeps them; pass --purge-build to remove.
#
# What this does NOT touch:
#   - The `opencode` and `cline` binaries themselves (you installed those).
#   - ~/.cline/ (cline's own config; never ours to delete).
#   - The user's standard ~/.config/opencode/ (we use opencode-anycli/).
#
# Usage:
#   ./uninstall.sh                 # remove symlink only, keep config + build
#   ./uninstall.sh --purge-config  # also remove ~/.config/opencode-anycli/
#   ./uninstall.sh --purge-build   # also remove this repo's dist/+node_modules
#   ./uninstall.sh --purge-all     # both --purge-config and --purge-build
#   ./uninstall.sh --user          # symlink lives at ~/.local/bin (default: auto)
#   ./uninstall.sh --system        # symlink lives at /usr/local/bin (sudo if needed)
#   ./uninstall.sh --no-symlink    # skip symlink removal (testing / partial)
#   ./uninstall.sh --sudo          # use sudo when removing /usr/local/bin entry
#   ./uninstall.sh --yes           # skip confirmation prompts
#   ./uninstall.sh -h | --help     # this help
set -e

# ─── Color helpers ────────────────────────────────────────────────────────────
# Use $'...' literals so the escape bytes are baked in at definition time —
# ${GREEN} then expands correctly inside cat <<EOF, echo, and printf alike.
if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; BLUE=$'\033[1;34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; DIM=""; RESET=""
fi
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info()  { printf "${BLUE}ℹ${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" 1>&2; }
step()  { printf "\n${BLUE}▶${RESET} %s\n" "$*"; }

# ─── Args ─────────────────────────────────────────────────────────────────────
PURGE_CONFIG=0
PURGE_BUILD=0
SCOPE="auto"    # auto | user | system | none
USE_SUDO=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge-config) PURGE_CONFIG=1 ;;
    --purge-build)  PURGE_BUILD=1 ;;
    --purge-all)    PURGE_CONFIG=1; PURGE_BUILD=1 ;;
    --user)         SCOPE="user" ;;
    --system)       SCOPE="system" ;;
    --no-symlink)   SCOPE="none" ;;
    --sudo)         USE_SUDO=1 ;;
    --yes|-y)       YES=1 ;;
    -h|--help)
      sed -n '3,31p' "$0"; exit 0 ;;
    *) err "unknown flag: $arg"; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

confirm() {
  # confirm "<prompt>" — skipped if --yes
  if [ "$YES" = "1" ]; then return 0; fi
  printf "${YELLOW}?${RESET} %s [y/N] " "$1"
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Track anything we couldn't fully remove so the final summary is accurate.
LEFTOVER_BINS=()

remove_symlink() {
  local link="$1"
  if [ -L "$link" ] || [ -f "$link" ]; then
    if [ -w "$(dirname "$link")" ]; then
      rm -f "$link"
      ok "removed $link"
      return 0
    fi
    # Need elevated permission. Use sudo if --sudo was passed, --yes was
    # passed (auto-consent), or the user agrees to a one-line prompt.
    # Falling back to a plain warning was the previous behaviour and left
    # root-owned legacy symlinks behind in /usr/local/bin even after
    # ./uninstall.sh — the most common "복완해도 안 지워진다" case.
    if ! command -v sudo >/dev/null 2>&1; then
      warn "$link needs root to remove and sudo is not on PATH; leaving it."
      LEFTOVER_BINS+=("$link")
      return 1
    fi
    local proceed=0
    if [ "$USE_SUDO" = "1" ] || [ "$YES" = "1" ]; then
      proceed=1
    elif confirm "Remove root-owned $link with sudo? (left over from a past --sudo install)"; then
      proceed=1
    fi
    if [ "$proceed" -eq 1 ]; then
      if sudo rm -f "$link"; then
        ok "removed $link (sudo)"
        return 0
      fi
      warn "sudo rm $link failed."
      LEFTOVER_BINS+=("$link")
      return 1
    fi
    warn "$link kept (user declined sudo removal)."
    LEFTOVER_BINS+=("$link")
    return 1
  fi
  if [ -e "$link" ]; then
    warn "$link exists but is neither a symlink nor a regular file — leaving it alone."
    LEFTOVER_BINS+=("$link")
    return 1
  fi
  info "nothing at $link (already removed)"
}

# ─── 1a. Remove the managed PATH block from the user's shell rc files ───────
# install.sh now appends an `export PATH=…` block bracketed by markers to
# .bashrc / .zshrc / fish config. Strip it back out here so an uninstall
# leaves the rc file in its pre-install state. We sweep all three rc
# locations regardless of $SHELL so users who run multiple shells get a
# clean removal.
step "Removing managed PATH block from shell rc files"
RC_FILES=("$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.config/fish/config.fish")
MARKER_BEGIN="# >>> opencode-anycli (managed by install.sh) >>>"
MARKER_END="# <<< opencode-anycli (managed by install.sh) <<<"
for rc in "${RC_FILES[@]}"; do
  if [ ! -f "$rc" ]; then continue; fi
  if ! grep -qF "$MARKER_BEGIN" "$rc"; then
    info "no managed block in $rc"
    continue
  fi
  tmp_rc="$(mktemp)"
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { inside = 1; next }
    $0 == e { inside = 0; next }
    !inside { print }
  ' "$rc" > "$tmp_rc"
  mv "$tmp_rc" "$rc"
  ok "removed managed PATH block from $rc"
done

# ─── 1b. Legacy fallback: remove any pre-PATH-block install artifact
#         install.sh used to drop a symlink into /usr/local/bin (--sudo /
#         default-system) or ~/.local/bin (--user). Both are gone in current
#         install.sh but a previous install may have left one (or several)
#         behind. Sweep every plausible location plus the npm-global bin
#         (in case some user did `npm link` from this checkout). Anything
#         not owned by the current user is escalated to sudo with the
#         user's consent (or auto if --yes / --sudo).
if [ "$SCOPE" = "none" ]; then
  step "Skipping legacy opencode-anycli binary removal (--no-symlink)"
  targets=()
else
  step "Removing legacy opencode-anycli binaries (if any)"
  # Build the candidate list. Use an associative-array-equivalent
  # de-duplication via the seen pattern so we don't try to remove the
  # same path twice when npm prefix happens to be /usr/local.
  raw=()
  case "$SCOPE" in
    user)   raw=("$HOME/.local/bin/opencode-anycli") ;;
    system) raw=("/usr/local/bin/opencode-anycli") ;;
    auto)
      raw+=("$HOME/.local/bin/opencode-anycli")
      raw+=("/usr/local/bin/opencode-anycli")
      raw+=("/usr/bin/opencode-anycli")
      # npm global bin (only if npm is actually installed). Captures
      # `npm link` from this repo, which would have created a real
      # binary there pointing back at packages/cli/bin/opencode-anycli.
      if command -v npm >/dev/null 2>&1; then
        npm_bin="$(npm prefix -g 2>/dev/null)/bin/opencode-anycli"
        raw+=("$npm_bin")
      fi
      ;;
  esac
  # Dedupe — order-preserving.
  targets=()
  for cand in "${raw[@]}"; do
    skip=0
    for already in "${targets[@]}"; do
      [ "$already" = "$cand" ] && { skip=1; break; }
    done
    [ "$skip" -eq 0 ] && targets+=("$cand")
  done
fi
for t in "${targets[@]}"; do remove_symlink "$t" || true; done

# ─── 2. Optionally purge config dir ───────────────────────────────────────────
CONFIG_HOME="$HOME/.config/opencode-anycli"
if [ "$PURGE_CONFIG" = "1" ]; then
  step "Purging config directory $CONFIG_HOME"
  if [ -d "$CONFIG_HOME" ]; then
    if confirm "Delete all of $CONFIG_HOME, including oh-my-anycli installed artifacts?"; then
      rm -rf "$CONFIG_HOME"
      ok "removed $CONFIG_HOME"
    else
      info "skipped (user declined)"
    fi
  else
    info "no config dir at $CONFIG_HOME (already removed)"
  fi
else
  if [ -d "$CONFIG_HOME" ]; then
    info "config dir kept: $CONFIG_HOME (re-run with --purge-config to remove)"
  fi
fi

# ─── 3. Optionally purge build artifacts in this repo ─────────────────────────
if [ "$PURGE_BUILD" = "1" ]; then
  step "Purging build artifacts: dist/ and node_modules/"
  removed=0
  for d in "$REPO_DIR/node_modules" \
           "$REPO_DIR/packages/cli/node_modules" \
           "$REPO_DIR/packages/cli/dist" \
           "$REPO_DIR/packages/provider-cline-cli/node_modules" \
           "$REPO_DIR/packages/provider-cline-cli/dist"; do
    if [ -d "$d" ]; then
      rm -rf "$d"
      ok "removed $d"
      removed=$((removed+1))
    fi
  done
  if [ "$removed" = "0" ]; then info "nothing to remove (already clean)"; fi
fi

# ─── 4. Final advice ──────────────────────────────────────────────────────────
# If any binary couldn't be removed (typically root-owned + user said no to
# sudo, or sudo missing), shout about it loudly so the user is not left
# thinking the uninstall finished cleanly when something is still on PATH.
if [ "${#LEFTOVER_BINS[@]}" -gt 0 ]; then
  printf "\n${RED}⚠ The following binaries could not be removed:${RESET}\n"
  for b in "${LEFTOVER_BINS[@]}"; do
    printf "  - %s\n" "$b"
  done
  printf "${DIM}Re-run with --sudo (or remove them manually) to finish the uninstall:${RESET}\n"
  for b in "${LEFTOVER_BINS[@]}"; do
    printf "  sudo rm -f %s\n" "$b"
  done
fi

if [ "${#LEFTOVER_BINS[@]}" -gt 0 ]; then
  printf "\n${YELLOW}Uninstall finished with leftovers (see above)${RESET}\n"
else
  printf "\n${GREEN}Uninstall complete${RESET}\n"
fi
cat <<EOF

${DIM}Left intact:${RESET}
  - opencode and cline binaries
  - ~/.cline/ (cline settings)
  - ~/.config/opencode/ (standard opencode settings)
EOF

if [ "$PURGE_CONFIG" = "0" ] && [ -d "$CONFIG_HOME" ]; then
  printf "  - %s ${DIM}(remove with --purge-config)${RESET}\n" "$CONFIG_HOME"
fi
if [ "$PURGE_BUILD" = "0" ]; then
  printf "  - %s ${DIM}(remove with --purge-build)${RESET}\n" "$REPO_DIR/{packages/*/dist,packages/*/node_modules}"
fi
echo
echo "${DIM}To remove this checkout itself, delete the directory: rm -rf $REPO_DIR${RESET}"

# Exit non-zero if anything was left behind so scripts driving uninstall
# know it wasn't fully clean.
[ "${#LEFTOVER_BINS[@]}" -eq 0 ]
