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
for arg in "$@"; do
  case "$arg" in
    --user) USER_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --sudo) USE_SUDO=1 ;;
    -h|--help)
      cat <<EOF
Usage: ./install.sh [--user] [--skip-build] [--sudo]

  --user        Symlink into ~/.local/bin instead of /usr/local/bin
  --skip-build  Skip the workspace build step (assumes dist/ exists)
  --sudo        Use sudo when symlinking to /usr/local/bin
EOF
      exit 0 ;;
    *) err "Unknown arg: $arg"; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── 1. Detect OS ─────────────────────────────────────────────────────────────
step "환경 감지 / Detecting environment"
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

# ─── 3. opencode binary ───────────────────────────────────────────────────────
if ! command -v opencode >/dev/null 2>&1; then
  err "opencode not found on PATH."
  cat <<EOF

  설치하세요 / Install opencode first:
    npm install -g opencode-ai

  npm 글로벌 설치가 실패한다면 opencode 저장소의 binary tarball을 사용할 수 있습니다:
    https://github.com/sst/opencode/releases

EOF
  exit 1
fi
ok "opencode: $(opencode --version 2>&1 | head -n1)"

# ─── 4. cline binary ──────────────────────────────────────────────────────────
if ! command -v cline >/dev/null 2>&1; then
  err "cline not found on PATH."
  cat <<EOF

  설치하세요 / Install cline first:
    npm install -g cline

  설치 후 cline을 한 번 실행해 모델과 인증 정보를 설정하세요 (cline의 첫 실행 가이드 참고).
  설정은 ~/.cline/data/globalState.json 에 저장됩니다.

EOF
  exit 1
fi
ok "cline: $(cline --version 2>&1 | head -n1)"

if [ ! -f "$HOME/.cline/data/globalState.json" ]; then
  warn "~/.cline/data/globalState.json 이 없습니다 — cline 을 먼저 한 번 실행해서 설정을 마치세요."
fi

# ─── 5. Build the provider ────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "빌드 / Building workspaces (this may take a minute on slow network links)"
  cd "$REPO_DIR"
  if command -v bun >/dev/null 2>&1; then
    info "bun 발견 — bun install + build 사용"
    bun install
    bun run build
  else
    info "npm 사용 (bun 없음)"
    npm install --workspaces --include-workspace-root
    npm run build --workspaces --if-present
  fi
  ok "Build complete"
else
  warn "--skip-build 가 지정되어 빌드를 건너뜁니다."
fi

# ─── 6. Copy default config ───────────────────────────────────────────────────
# Path layout note: the wrapper sets XDG_CONFIG_HOME=$HOME/.config/openclineclicode
# at spawn time, so opencode auto-discovers commands/agents/skills under
# $HOME/.config/openclineclicode/opencode/. The opencode.json must therefore
# live one directory deeper than the wrapper's XDG dir.
step "기본 설정 / Installing default opencode.json"
CONFIG_DIR="$HOME/.config/openclineclicode/opencode"
mkdir -p "$CONFIG_DIR"
TARGET="$CONFIG_DIR/opencode.json"
SOURCE="$REPO_DIR/templates/opencode.json"
PROVIDER_DIST="$REPO_DIR/packages/provider-cline-cli/dist/index.js"
if [ ! -f "$PROVIDER_DIST" ]; then
  err "Provider dist not found: $PROVIDER_DIST"
  err "빌드를 먼저 실행하세요. (--skip-build 없이 ./install.sh 다시 실행)"
  exit 1
fi
if [ -f "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%s)"
  cp "$TARGET" "$BACKUP"
  warn "기존 설정 백업: $BACKUP"
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
step "심볼릭 링크 / Linking openclineclicode binary"
BIN_SRC="$REPO_DIR/packages/cli/bin/openclineclicode"
chmod +x "$BIN_SRC" || true

if [ "$USER_INSTALL" -eq 1 ]; then
  TARGET_DIR="$HOME/.local/bin"
  mkdir -p "$TARGET_DIR"
  ln -sf "$BIN_SRC" "$TARGET_DIR/openclineclicode"
  ok "Linked to $TARGET_DIR/openclineclicode"
  case ":$PATH:" in
    *":$TARGET_DIR:"*) : ;;
    *) warn "$TARGET_DIR 이 PATH에 없습니다. ~/.zshrc 또는 ~/.bashrc 에 추가하세요:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
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
    warn "$TARGET_DIR 에 쓰기 권한이 없습니다."
    info "다시 실행: ./install.sh --user   (또는 --sudo)"
    exit 1
  fi
fi

# ─── 8. Next steps ────────────────────────────────────────────────────────────
cat <<EOF

${GREEN}설치 완료 / Installation complete${RESET}

  1) 진단 실행 / Run the doctor:        ${BLUE}openclineclicode --doctor${RESET}
  2) opencode TUI 시작 / Start opencode: ${BLUE}openclineclicode${RESET}
  3) 설정 수정 / Edit config:           ${BLUE}\$EDITOR $TARGET${RESET}
  4) 문제 발생 시 / Troubleshooting:    ${BLUE}docs/troubleshooting.md${RESET}
  5) 다른 mode 시도 / Try passthrough:  ${BLUE}docs/provider-modes.md${RESET}

EOF
