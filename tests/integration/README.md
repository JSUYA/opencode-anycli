# Integration tests

Bash-driven regression suites for install / uninstall / update flows
that the unit-test (vitest) layer cannot cover, since they involve
real filesystem mutations, real `git` operations, and real shell rc
file editing.

Each script is fully isolated: it redirects `$HOME` AND
`npm_config_prefix` to a per-test temp dir before invoking `install.sh`
/ `uninstall.sh`, and creates throwaway bare-upstream + clone pairs for
`--update` flow tests. They never touch the real user's `~/.bashrc`,
`~/.config/`, the real global node_modules tree, or the real `origin`
remote.

## Running

```sh
./tests/integration/install-tests.sh   # 12 cases: npm link creation,
                                       # idempotency, legacy PATH block
                                       # auto-cleanup, uninstall
./tests/integration/update-tests.sh    # 14 cases: clean tree, dirty tree
                                       # (tracked + untracked stash/pop),
                                       # pop conflict → stash@{0} preserved
```

Both exit non-zero on any failure and list which cases failed.

## What they cover

`install-tests.sh`:
- T1-T2 — `npm link` produces a global symlink that resolves back to
          `packages/cli/bin/opencode-anycli`; re-running stays idempotent
- T3-T5 — legacy managed PATH blocks in `.bashrc` / `.zshrc` are stripped
          automatically; unrelated rc content is preserved; no-op when
          no legacy block exists
- T6     — deprecated `--user` / `--sudo` flags are silent no-ops but
           still produce the link
- T8-T9 — uninstall runs `npm unlink -g opencode-anycli` and removes the
          symlink; no-op on hosts with no prior install
- T10-T12 — uninstall strips legacy PATH blocks from `.bashrc` / `.zshrc`,
            sweeps both shells, and removes multiple duplicate blocks
- T13a-T13b — legacy `~/.local/bin/opencode-anycli` symlink sweep;
              `--no-symlink` preserves intentional partial-uninstall state

`update-tests.sh`:
- T18 — clean tree → no stash, plain pull + install
- T19 — dirty tree → stash includes untracked, pop restores everything
- T20 — pop conflict → stash@{0} stays put + recovery hint surfaced
