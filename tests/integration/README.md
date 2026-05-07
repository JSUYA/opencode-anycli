# Integration tests

Bash-driven regression suites for install / uninstall / update flows
that the unit-test (vitest) layer cannot cover, since they involve
real filesystem mutations, real `git` operations, and real shell rc
file editing.

Each script is fully isolated: it redirects `$HOME` to a per-test temp
dir before invoking `install.sh` / `uninstall.sh`, and creates throwaway
bare-upstream + clone pairs for `--update` flow tests. They never touch
the real user's `~/.bashrc`, `~/.config/`, or the real `origin` remote.

## Running

```sh
./tests/integration/install-tests.sh   # 39 cases: rc states, idempotency,
                                       # corruption recovery, shell detection,
                                       # uninstall block stripping
./tests/integration/update-tests.sh    # 14 cases: clean tree, dirty tree
                                       # (tracked + untracked stash/pop),
                                       # pop conflict → stash@{0} preserved
```

Both exit non-zero on any failure and list which cases failed.

## What they cover

`install-tests.sh`:
- T1-T3 — fresh rc states (missing / empty / unrelated content present)
- T4   — idempotent re-run (3× → still 1 managed block)
- T5-T7 — recovery from stale path / missing END marker / duplicate blocks
- T8-T11 — shell detection (bash, zsh, ZDOTDIR, fish, unknown)
- T12-T13 — rc without trailing newline; deprecated `--user`/`--sudo`
- T14-T17 — uninstall removes managed block; preserves unrelated lines;
            strips multiple legacy duplicates; sweeps both bash + zsh

`update-tests.sh`:
- T18 — clean tree → no stash, plain pull + install
- T19 — dirty tree → stash includes untracked, pop restores everything
- T20 — pop conflict → stash@{0} stays put + recovery hint surfaced
