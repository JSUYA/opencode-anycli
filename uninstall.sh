#!/usr/bin/env bash
# uninstall.sh — remove what install.sh placed on this machine.
#
# What this removes:
#   1. The `openclineclicode` symlink in /usr/local/bin or ~/.local/bin
#   2. Optionally: ~/.config/openclineclicode/ (the wrapper's XDG home,
#      including opencode.json + AGENTS.md + any .bak backups + anything
#      oh-my-clinecli installed under it). Default behaviour KEEPS the
#      config so a re-install can restore it; pass --purge-config to remove.
#   3. Optionally: dist/ + node_modules/ inside this repo (the build).
#      Default keeps them; pass --purge-build to remove.
#
# What this does NOT touch:
#   - The `opencode` and `cline` binaries themselves (you installed those).
#   - ~/.cline/ (cline's own config; never ours to delete).
#   - The user's standard ~/.config/opencode/ (we use openclineclicode/).
#
# Usage:
#   ./uninstall.sh                 # remove symlink only, keep config + build
#   ./uninstall.sh --purge-config  # also remove ~/.config/openclineclicode/
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

remove_symlink() {
  local link="$1"
  if [ -L "$link" ]; then
    if [ -w "$(dirname "$link")" ]; then
      rm "$link"
      ok "removed symlink $link"
    elif [ "$USE_SUDO" = "1" ]; then
      sudo rm "$link"
      ok "removed symlink $link (sudo)"
    else
      warn "no write permission for $(dirname "$link"). Re-run with --sudo."
      return 1
    fi
  elif [ -e "$link" ]; then
    warn "$link exists but is not a symlink — leaving it alone."
  else
    info "no symlink at $link (already removed)"
  fi
}

# ─── 1. Locate and remove the openclineclicode symlink ────────────────────────
if [ "$SCOPE" = "none" ]; then
  step "openclineclicode 심볼릭 링크 제거 / Skipping symlink removal (--no-symlink)"
  targets=()
else
  step "openclineclicode 심볼릭 링크 제거 / Removing CLI symlink"
  case "$SCOPE" in
    user)   targets=("$HOME/.local/bin/openclineclicode") ;;
    system) targets=("/usr/local/bin/openclineclicode") ;;
    auto)   targets=("/usr/local/bin/openclineclicode" "$HOME/.local/bin/openclineclicode") ;;
  esac
fi
for t in "${targets[@]}"; do remove_symlink "$t" || true; done

# ─── 2. Optionally purge config dir ───────────────────────────────────────────
CONFIG_HOME="$HOME/.config/openclineclicode"
if [ "$PURGE_CONFIG" = "1" ]; then
  step "설정 디렉터리 제거 / Purging $CONFIG_HOME"
  if [ -d "$CONFIG_HOME" ]; then
    if confirm "정말 $CONFIG_HOME 전체를 삭제할까요? (oh-my-clinecli 설치물 포함)"; then
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
  step "빌드 산출물 제거 / Purging dist/ and node_modules/"
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
cat <<EOF

${GREEN}제거 완료 / Uninstall complete${RESET}

${DIM}건드리지 않은 것 / Left intact:${RESET}
  - opencode / cline 바이너리 자체
  - ~/.cline/ (cline 자체 설정)
  - ~/.config/opencode/ (사용자 표준 opencode 설정)
EOF

if [ "$PURGE_CONFIG" = "0" ] && [ -d "$CONFIG_HOME" ]; then
  printf "  - %s ${DIM}(--purge-config 로 제거 가능)${RESET}\n" "$CONFIG_HOME"
fi
if [ "$PURGE_BUILD" = "0" ]; then
  printf "  - %s ${DIM}(--purge-build 로 제거 가능)${RESET}\n" "$REPO_DIR/{packages/*/dist,packages/*/node_modules}"
fi
echo
echo "${DIM}이 저장소 자체를 지우려면 그냥 디렉터리를 삭제하세요: rm -rf $REPO_DIR${RESET}"
