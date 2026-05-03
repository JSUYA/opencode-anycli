#!/usr/bin/env bash
#
# setup-docker.sh — install Docker on Linux, add the user to the `docker`
# group, start the daemon, and verify with a hello-world container.
#
# Why this exists:
#   sandboxed-browser-testing (and any future Docker-based skill) needs
#   a working `docker` command runnable by the current user without sudo.
#   Manually doing the steps requires several sudo prompts that the cline
#   subprocess cannot answer. This script chains them so the user only
#   needs sudo once (or zero times if --setup-sudo --for-docker has been
#   applied first).
#
# Usage:
#   bash scripts/setup-docker.sh         # interactive: install + group + start + verify
#   bash scripts/setup-docker.sh --yes   # non-interactive
#   bash scripts/setup-docker.sh --print  # show what would be done
#
# What this does (Linux only):
#   1. Detect package manager (apt / dnf / yum / pacman / zypper)
#   2. Install docker.io / docker-ce / podman-docker depending on distro
#   3. sudo systemctl enable --now docker  (if systemd is present)
#   4. sudo usermod -aG docker "$USER"
#   5. Print instructions for activating the new group membership
#      (newgrp docker  OR  log out / log back in)
#   6. Verify: run `docker run --rm hello-world` (after newgrp)
#
# macOS short-circuits — Docker Desktop / colima / orbstack must be set
# up by the user manually; we cannot install GUI Docker via shell.
#
set -euo pipefail

ASSUME_YES=0
PRINT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --print)  PRINT_ONLY=1 ;;
    -h|--help)
      sed -n '3,30p' "$0"
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ]; then
  G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; B=$'\033[1;34m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; B=""; D=""; N=""
fi

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin)
    printf "%bℹ%b macOS — Docker on macOS requires Docker Desktop, colima, or orbstack.\n" "$B" "$N"
    printf "  Install one of:\n"
    printf "    brew install --cask docker          # Docker Desktop\n"
    printf "    brew install colima docker          # Colima (lighter)\n"
    printf "    brew install --cask orbstack        # OrbStack\n"
    printf "  Then start it once and verify with: docker run --rm hello-world\n"
    exit 0
    ;;
  Linux) ;;
  *)
    printf "%b✗%b Unsupported OS: %s\n" "$R" "$N" "$OS_NAME"; exit 1 ;;
esac

# ─── Detect package manager + install command ────────────────────────────────
INSTALL_CMD=""
PKG_NAME="docker.io"
DISTRO=""
if command -v apt-get >/dev/null 2>&1; then
  DISTRO="Debian/Ubuntu"
  # On Ubuntu 22.04+ docker.io is in the default repos and is the simplest path.
  INSTALL_CMD="sudo apt-get update -y && sudo apt-get install -y docker.io"
  PKG_NAME="docker.io"
elif command -v dnf >/dev/null 2>&1; then
  DISTRO="Fedora/RHEL"
  INSTALL_CMD="sudo dnf install -y docker"
  PKG_NAME="docker"
elif command -v yum >/dev/null 2>&1; then
  DISTRO="RHEL/CentOS (yum)"
  INSTALL_CMD="sudo yum install -y docker"
  PKG_NAME="docker"
elif command -v pacman >/dev/null 2>&1; then
  DISTRO="Arch"
  INSTALL_CMD="sudo pacman -S --noconfirm docker"
  PKG_NAME="docker"
elif command -v zypper >/dev/null 2>&1; then
  DISTRO="openSUSE"
  INSTALL_CMD="sudo zypper install -y docker"
  PKG_NAME="docker"
else
  printf "%b✗%b Could not detect a known Linux package manager.\n" "$R" "$N"
  printf "  Install Docker manually following https://docs.docker.com/engine/install/\n"
  exit 1
fi

# ─── Plan ─────────────────────────────────────────────────────────────────────
PLAN_INSTALL="$INSTALL_CMD"
PLAN_ENABLE="(systemctl present? sudo systemctl enable --now docker)"
PLAN_GROUP="sudo usermod -aG docker $USER"
PLAN_VERIFY="docker run --rm hello-world  (after newgrp docker / re-login)"

print_plan() {
  printf "%b▶%b Detected: %s\n" "$B" "$N" "$DISTRO"
  printf "%b▶%b Plan (4 steps):\n" "$B" "$N"
  printf "    1. %s\n" "$PLAN_INSTALL"
  printf "    2. %s\n" "$PLAN_ENABLE"
  printf "    3. %s\n" "$PLAN_GROUP"
  printf "    4. %s\n" "$PLAN_VERIFY"
}

if [ "$PRINT_ONLY" -eq 1 ]; then
  print_plan
  printf "\n%bRun without --print to apply.%b\n" "$D" "$N"
  exit 0
fi

# ─── Confirm ─────────────────────────────────────────────────────────────────
print_plan
printf "\n"
if [ "$ASSUME_YES" -ne 1 ]; then
  if [ ! -t 0 ]; then
    printf "%b✗%b Non-interactive shell. Re-run with --yes to apply.\n" "$R" "$N"
    exit 1
  fi
  printf "%b?%b Proceed? [y/N] " "$Y" "$N"
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) printf "Aborted.\n"; exit 0 ;; esac
fi

# ─── Step 1: install ─────────────────────────────────────────────────────────
printf "\n%b▶%b Step 1/4: installing %s\n" "$B" "$N" "$PKG_NAME"
if command -v docker >/dev/null 2>&1; then
  printf "%b✓%b docker already installed: %s\n" "$G" "$N" "$(docker --version 2>/dev/null | head -n1)"
else
  # eval is needed because INSTALL_CMD contains shell operators (&&, etc.).
  # All values come from the static distro detection above, not user input.
  eval "$INSTALL_CMD"
  printf "%b✓%b installed: %s\n" "$G" "$N" "$(docker --version 2>/dev/null | head -n1)"
fi

# ─── Step 2: enable + start daemon ───────────────────────────────────────────
printf "\n%b▶%b Step 2/4: enable + start dockerd\n" "$B" "$N"
if command -v systemctl >/dev/null 2>&1; then
  if sudo systemctl enable --now docker; then
    printf "%b✓%b systemd unit enabled and started\n" "$G" "$N"
  else
    printf "%b⚠%b systemctl enable/start failed; check 'systemctl status docker'\n" "$Y" "$N"
  fi
else
  printf "%b⚠%b systemd not detected — start the daemon yourself ('sudo dockerd &' or your init system)\n" "$Y" "$N"
fi

# ─── Step 3: add user to docker group ────────────────────────────────────────
printf "\n%b▶%b Step 3/4: add %s to the docker group\n" "$B" "$N" "$USER"
if id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  printf "%b✓%b %s already in docker group\n" "$G" "$N" "$USER"
else
  sudo usermod -aG docker "$USER"
  printf "%b✓%b added %s to docker group\n" "$G" "$N" "$USER"
fi

# ─── Step 4: activation + verify ─────────────────────────────────────────────
printf "\n%b▶%b Step 4/4: activate group membership + verify\n" "$B" "$N"
printf "%b⚠%b The new docker group membership is NOT active in this shell yet.\n" "$Y" "$N"
printf "  To activate it for the current shell:\n"
printf "      %bnewgrp docker%b\n" "$D" "$N"
printf "  Or log out and log back in for it to apply everywhere.\n\n"
printf "  After activation, verify with:\n"
printf "      %bdocker run --rm hello-world%b\n\n" "$D" "$N"

# Best-effort verification right now (works only if the user is already a
# member of the docker group OR sudo is available).
if docker info >/dev/null 2>&1; then
  printf "%b✓%b docker info OK in this shell — group already active.\n" "$G" "$N"
elif sudo -n docker info >/dev/null 2>&1; then
  printf "%bℹ%b docker info works via sudo. Run 'newgrp docker' or re-login\n" "$B" "$N"
  printf "  to access docker without sudo.\n"
else
  printf "%bℹ%b docker info requires group activation (newgrp docker) or sudo.\n" "$B" "$N"
fi

cat <<EOF

${G}Done.${N} Once the docker group is active in your shell:

    docker run --rm hello-world

opencode-anycli sessions can then run docker-based sandbox skills (e.g.
sandboxed-browser-testing in oh-my-anycli).

If you want sudo NOPASSWD for docker setup helpers (usermod / systemctl
/ groupadd) so re-running this script doesn't prompt:

    opencode-anycli --setup-sudo --for-docker --yes
EOF
