#!/usr/bin/env bash
# Live tests for `opencode-anycli --update` auto-stash + pop bracket.
# Each test sets up an isolated bare-upstream + clone, drives --update via
# the clone's own binary, then asserts state.

set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0; FAILED_NAMES=()

assert_eq() {
  local n="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf '  \033[1;32m✓\033[0m %s\n' "$n"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$n")
    printf '  \033[1;31m✗\033[0m %s\n' "$n"
    printf '      got:  %s\n      want: %s\n' "$got" "$want"
  fi
}
assert_contains() {
  local n="$1" hay="$2" needle="$3"
  if printf '%s' "$hay" | grep -qF "$needle"; then
    PASS=$((PASS+1)); printf '  \033[1;32m✓\033[0m %s\n' "$n"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$n")
    printf '  \033[1;31m✗\033[0m %s\n' "$n"
    printf '      hay tail: %s\n      missing:  %s\n' "$(printf '%s' "$hay" | tail -c 200)" "$needle"
  fi
}
section() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
line_count() {
  wc -l | tr -d '[:space:]'
}
copy_dir_contents() {
  local src="$1" dst="$2"
  mkdir -p "$dst"
  cp -R "$src"/. "$dst"/
}

setup_clone() {
  # Creates: /tmp/test-XXX/{upstream.git, clone}; clone tracks upstream.
  local root; root=$(mktemp -d /tmp/update-test-XXXXXXXX)
  local upstream="$root/upstream.git"
  local clone="$root/clone"
  git -C "$REPO" clone --bare "$REPO" "$upstream" >/dev/null 2>&1
  git clone "$upstream" "$clone" >/dev/null 2>&1
  # Copy ONLY the gitignored build artefacts (dist + node_modules) from the
  # developer's working repo, so install.sh --skip-build still finds them.
  # We deliberately do NOT rsync the entire `packages/` tree — that would
  # also drag the developer's uncommitted source edits onto the clone's
  # clean checkout, making `git status --porcelain` non-empty before
  # `--update` even starts. T18 (clean tree) would then fail spuriously
  # whenever a developer has WIP. Source files come from `git clone` and
  # are guaranteed clean.
  for pkg in "$REPO"/packages/*/; do
    local pkg_name; pkg_name=$(basename "$pkg")
    if [ -d "$pkg/dist" ]; then
      copy_dir_contents "$pkg/dist" "$clone/packages/$pkg_name/dist"
    fi
    if [ -d "$pkg/node_modules" ]; then
      copy_dir_contents "$pkg/node_modules" "$clone/packages/$pkg_name/node_modules"
    fi
  done
  if [ -d "$REPO/node_modules" ]; then
    copy_dir_contents "$REPO/node_modules" "$clone/node_modules"
  fi
  echo "$root"
}

# Drive --update from the clone's bin so locateRepoArtifact resolves to the
# clone's install.sh, not the real one. Redirect HOME to keep config edits
# isolated from the user's real ~/.config.
run_update() {
  local clone="$1"; shift
  local fake_home; fake_home=$(mktemp -d "$clone/../fake-home-XXXXXXXX")
  HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" SHELL=/bin/bash \
    "$clone/packages/cli/bin/opencode-anycli" --update --skip-build "$@" 2>&1
}


section "--update: clean tree (no stash needed)"
T=$(setup_clone); CLONE="$T/clone"
out=$(run_update "$CLONE")
assert_eq "T18 clean tree → did NOT print 'stashing local changes'" \
  "$(printf '%s' "$out" | grep -c stashing | tr -d '[:space:]')" "0"
assert_contains "T18 clean tree → printed 'pulling latest'" "$out" "pulling latest"
assert_contains "T18 clean tree → ran install.sh (PATH section)" "$out" "Adding opencode-anycli to your shell PATH"
assert_eq "T18 clean tree → working tree still clean afterwards" \
  "$(git -C "$CLONE" status --porcelain | line_count)" "0"
rm -rf "$T"


section "--update: dirty tree → auto-stash, pull, pop"
T=$(setup_clone); CLONE="$T/clone"
echo "// LOCAL EDIT" >> "$CLONE/README.md"
mkdir -p "$CLONE/packages/cli/src"
echo "untracked" > "$CLONE/junsu-untracked.txt"
before_status=$(cd "$CLONE" && git status --porcelain | sort)
out=$(run_update "$CLONE")
assert_contains "T19 dirty tree → 'stashing local changes' fired" "$out" "stashing local changes"
assert_contains "T19 dirty tree → 'restoring stashed local changes'" "$out" "restoring stashed local changes"
# After pop, both the tracked edit AND the untracked file should be back.
after_status=$(cd "$CLONE" && git status --porcelain | sort)
assert_eq "T19 dirty tree → status restored exactly after pop" "$after_status" "$before_status"
assert_eq "T19 dirty tree → README local edit restored" \
  "$(grep -c 'LOCAL EDIT' "$CLONE/README.md")" "1"
assert_eq "T19 dirty tree → untracked file restored" \
  "$([ -f "$CLONE/junsu-untracked.txt" ] && echo yes || echo no)" "yes"
assert_eq "T19 dirty tree → no leftover stash entries" \
  "$(git -C "$CLONE" stash list | line_count)" "0"
rm -rf "$T"


section "--update: stash pop conflict → stash@{0} preserved + recovery hint"
T=$(setup_clone); CLONE="$T/clone"
UPSTREAM="$T/upstream.git"
# Set up a conflict: clone has uncommitted edit on README; upstream gets a
# competing commit on the same lines so pull-then-pop will conflict.
SCRATCH=$(mktemp -d "$T/scratch-XXXXXXXX")
git clone "$UPSTREAM" "$SCRATCH" >/dev/null 2>&1
echo "// UPSTREAM CHANGE" >> "$SCRATCH/README.md"
git -C "$SCRATCH" -c user.email=t@t -c user.name=t commit -am "upstream change" >/dev/null
git -C "$SCRATCH" push origin main >/dev/null 2>&1
# Now clone is behind. Add a CONFLICTING local edit on the same trailing
# region of README.md so that after fast-forward pull, the stashed edit
# can no longer apply cleanly.
echo "// CLONE CHANGE that will conflict" >> "$CLONE/README.md"
out=$(run_update "$CLONE")
assert_contains "T20 conflict → 'stash pop' had conflicts surfaced" "$out" "stash pop"
assert_contains "T20 conflict → 'still safe in stash@{0}' hint" "$out" "still safe in stash@{0}"
# Stash should still exist
n_stash=$(git -C "$CLONE" stash list | line_count)
assert_eq "T20 conflict → stash@{0} preserved (1 entry)" "$n_stash" "1"
# Stash message should mention 'opencode-anycli auto-stash'
assert_contains "T20 conflict → stash message contains 'opencode-anycli auto-stash'" \
  "$(git -C "$CLONE" stash list)" "opencode-anycli auto-stash"
rm -rf "$T"


section "Summary"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m%d/%d tests passed.\033[0m\n' "$PASS" "$TOTAL"
  exit 0
else
  printf '\033[1;31m%d/%d tests passed (%d failed).\033[0m\n' "$PASS" "$TOTAL" "$FAIL"
  printf '\nFailed:\n'
  for n in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$n"; done
  exit 1
fi
