#!/usr/bin/env bash
# fix.sh — interactive recovery for known broken states that block
# opencode-anycli startup. Each step is opt-in (single y/N prompt) so
# the script never destroys user data without consent. Pass `--yes`
# to auto-confirm every prompt (CI / scripted recovery).
#
# Currently handles:
#   1. Files inside the opencode data/config dirs that ended up owned
#      by root after a past --allow-dangerously-skip-permissions
#      session — chown them back to the current user.
#   2. A corrupt opencode SQLite DB (the wal_checkpoint / integrity
#      check failure that surfaces as
#      `DrizzleError: Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'`
#      on every startup) — back up the broken file and let opencode
#      regenerate a fresh DB on next run.
#   3. The npm cache pollution from sudo+HOME-preserving installs
#      (root-owned entries in ~/.npm/_cacache that break later
#      `npm install` runs).
#
# What this does NOT touch unless explicitly asked:
#   - The user's opencode.json / tui.json / AGENTS.md (run
#     opencode-anycli --doctor to inspect those).
#   - opencode + cline binaries (they are reinstalled by install.sh).
#   - Any file outside the listed data / cache dirs.

set -u

if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ]; then
  GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; BLUE=$'\033[1;34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; DIM=""; RESET=""
fi
ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
info()    { printf "  ${BLUE}ℹ${RESET} %s\n" "$*"; }
warn()    { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
err()     { printf "  ${RED}✗${RESET} %s\n" "$*" 1>&2; }
note()    { printf "  ${DIM}↳ %s${RESET}\n" "$*"; }
section() { printf "\n${BLUE}▶ %s${RESET}\n" "$*"; }

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--yes]

Interactive recovery for known opencode-anycli broken states. Each
step prompts before changing anything.

  --yes, -y    Skip confirmation prompts (auto-yes on every step).
EOF
      exit 0 ;;
    *) err "unknown arg: $arg"; exit 2 ;;
  esac
done

confirm() {
  # confirm "<prompt>" — returns 0 (yes) or 1 (no). Default = no.
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi   # non-TTY → never auto-yes
  printf "  ${YELLOW}?${RESET} %s [y/N] " "$1"
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

did_anything=0
had_failures=0

# ─── Step 1: Reclaim ownership of opencode dirs ──────────────────────────────
# A past `opencode-anycli --allow-dangerously-skip-permissions` (which
# re-execs the whole session under sudo -E) creates files that get owned
# by root inside ~/.local/share/opencode/, ~/.config/opencode-anycli/, and
# ~/.cline/data/. Subsequent non-elevated runs then fail with EACCES on
# their first write. Sweep all three.
DIRS_TO_CHECK=(
  "$HOME/.local/share/opencode"
  "$HOME/.config/opencode-anycli"
  "$HOME/.cline/data"
)
for d in "${DIRS_TO_CHECK[@]}"; do
  [ -d "$d" ] || continue
  bad="$(find "$d" -not -user "$USER" 2>/dev/null | head -50)"
  if [ -z "$bad" ]; then continue
  fi
  count=$(printf '%s\n' "$bad" | wc -l)
  section "Files not owned by $USER in $d ($count entries, showing up to 5)"
  printf '%s\n' "$bad" | head -5 | while read -r f; do note "$f"; done
  if confirm "Reclaim ownership with 'sudo chown -R $USER:$USER $d'?"; then
    if sudo chown -R "$USER":"$USER" "$d"; then
      ok "ownership reclaimed for $d"
      did_anything=1
    else
      err "sudo chown failed; the entries above are still root-owned."
      had_failures=1
    fi
  else
    info "skipped"
  fi
done

# ─── Step 2: Recreate a broken opencode SQLite DB ────────────────────────────
# opencode logs `DrizzleError: Failed to run the query 'PRAGMA wal_checkpoint(PASSIVE)'`
# at startup when the DB or its WAL companion is unrecoverable. Easiest fix
# is to move the file aside — opencode creates a fresh, empty DB on next
# run. The user loses their session history but everything else (config,
# cline credentials, oh-my-anycli installs) is unaffected.
DB_DIR="$HOME/.local/share/opencode"
DB_FILE="$DB_DIR/opencode.db"
if [ -f "$DB_FILE" ]; then
  db_broken=0
  reason=""
  if ! [ -r "$DB_FILE" ] || ! [ -w "$DB_FILE" ]; then
    db_broken=1
    reason="not readable/writable by $USER"
  elif command -v sqlite3 >/dev/null 2>&1; then
    if ! check="$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>&1)"; then
      db_broken=1
      reason="sqlite3 cannot open ($check)"
    elif [ "$(printf '%s\n' "$check" | head -1)" != "ok" ]; then
      db_broken=1
      reason="integrity_check returned: $(printf '%s' "$check" | head -1)"
    fi
  else
    info "sqlite3 not on PATH — cannot verify $DB_FILE; skipping integrity check."
    note "  (install sqlite3 with 'apt install sqlite3' / 'brew install sqlite3' to enable this check)"
  fi
  if [ "$db_broken" = "1" ]; then
    section "opencode DB at $DB_FILE looks broken"
    note "$reason"
    note "Backing up will preserve the file as <db>.broken.<ts>; session"
    note "history is lost but opencode regenerates an empty DB on next run."
    if confirm "Move the broken DB aside?"; then
      ts="$(date +%s)"
      mv "$DB_FILE" "$DB_FILE.broken.$ts"
      rm -f "$DB_DIR/opencode.db-wal" "$DB_DIR/opencode.db-shm"
      ok "moved to $DB_FILE.broken.$ts (and removed -wal / -shm companions)"
      did_anything=1
    else
      info "skipped"
    fi
  fi
fi

# ─── Step 3: Reclaim ownership of npm cache ──────────────────────────────────
# Same root-cause as step 1: a past sudo+HOME-preserving install left
# root-owned dirs in ~/.npm/_cacache, blocking later `npm install` runs
# inside install.sh's build step with EACCES + "File exists" on mkdir.
NPM_CACHE="$HOME/.npm"
if [ -d "$NPM_CACHE" ]; then
  bad="$(find "$NPM_CACHE" -not -user "$USER" 2>/dev/null | head -50)"
  if [ -n "$bad" ]; then
    count=$(printf '%s\n' "$bad" | wc -l)
    section "Files not owned by $USER in $NPM_CACHE ($count entries, showing up to 5)"
    printf '%s\n' "$bad" | head -5 | while read -r f; do note "$f"; done
    if confirm "Reclaim ownership with 'sudo chown -R $USER:$USER $NPM_CACHE'?"; then
      if sudo chown -R "$USER":"$USER" "$NPM_CACHE"; then
        ok "ownership reclaimed for $NPM_CACHE"
        did_anything=1
      else
        err "sudo chown failed."
        had_failures=1
      fi
    else
      info "skipped"
      note "alternative: 'npm cache clean --force' wipes the cache but takes longer to repopulate."
    fi
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
if [ "$had_failures" = "1" ]; then
  printf "${YELLOW}fix incomplete${RESET} — one or more steps failed (see above).\n"
  printf "Re-run with TTY access (sudo needs to prompt for password) or fix the\n"
  printf "underlying issue and try again. Alternatively use --fix-yes after you've\n"
  printf "set up passwordless sudo for these chown / mv operations.\n"
  exit 1
elif [ "$did_anything" = "1" ]; then
  printf "${GREEN}fix complete${RESET} — re-run opencode-anycli to verify.\n"
else
  printf "${GREEN}nothing to fix${RESET} — no known broken states detected.\n"
fi
