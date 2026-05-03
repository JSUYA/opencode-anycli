# opencode-anycli

> Run the opencode AI coding agent through your locally installed cline CLI.

opencode-anycli installs a small opencode adapter that forwards model requests to `cline --json --yolo --act <prompt>`. cline keeps using the model, credentials, and tool behavior the user has already configured.

## Upstream projects & what this bundle adds

This bundle does **not** fork or modify opencode or cline. It is a thin wrapping
layer that lets the two tools talk to each other.

| Upstream / dependency | License | Used as | What this bundle changes upstream |
|---|---|---|---|
| [`sst/opencode`](https://github.com/sst/opencode) | MIT | The TUI / multi-agent runtime | Nothing — invoked as a subprocess (`spawn("opencode", …)`) with `XDG_CONFIG_HOME` redirected for isolation |
| [`cline/cline`](https://github.com/cline/cline) | Apache-2.0 | The actual LLM caller (uses the user's existing config) | Nothing — invoked per request as `cline --json --yolo --act <prompt>` |
| [`@ai-sdk/provider`](https://www.npmjs.com/package/@ai-sdk/provider) v3 | Apache-2.0 | Vercel AI SDK `LanguageModelV3` contract our provider implements | Nothing — we conform to the contract |

**This bundle adds (new code in this repo):**

- `@opencode-anycli/provider-cline-cli` — `LanguageModelV3` implementation that
  spawns cline as a subprocess and parses its NDJSON event stream
- `opencode-anycli` CLI — thin entry point that resolves config, sets
  `XDG_CONFIG_HOME=$HOME/.config/opencode-anycli` for isolation, and spawns
  opencode with stdio inherited
- Templates (`templates/opencode.json`, `templates/AGENTS.md`),
  install/doctor scripts, docs, and 52 unit tests

No source files are copied from opencode, cline, or the AI SDK. We import
`@ai-sdk/provider` types only.

## Why This Exists

- opencode provides a strong TUI and multi-agent workflow.
- cline CLI already knows how to call the user's configured model.
- This bundle connects the two without asking users to duplicate model settings in opencode.

## Coding Advantages Over Plain cline CLI

opencode-anycli does not improve model quality by itself; cline still uses the same configured model. The advantage is that coding work runs inside opencode's project-oriented workflow instead of a raw one-shot CLI prompt.

- **Better codebase navigation:** use opencode's TUI, session context, and file-aware workflow while delegating model calls to cline.
- **More structured implementation:** feature work can be handled as inspect -> plan -> edit -> verify instead of a single loose prompt.
- **More reliable debugging:** runtime failures can be analyzed through code-path tracing, ranked hypotheses, minimal fixes, and follow-up tests.
- **Config isolation:** opencode-anycli keeps its opencode config, skills, commands, and agents under `~/.config/opencode-anycli` instead of mixing them with a user's normal opencode setup.
- **Workflow extension point:** oh-my-anycli can add reusable slash commands, skills, and subagents on top of the same cline-backed model path.

For tiny edits or quick questions, direct cline CLI can still be faster. opencode-anycli is most useful when the coding task benefits from navigation, repeatable process, and verification.

## Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh
```

`opencode` and `cline` are treated as **bundled runtime dependencies of
opencode-anycli** — if either is missing on `PATH`, the installer fetches
it for you via `npm install -g` (no extra flag required). Conceptually,
`opencode-anycli` IS opencode + cline + our provider/config wired
together; the three pieces just happen to ship as separate npm packages
upstream.

Optional flags:

| Flag | When to use |
|---|---|
| `--user` | Symlink into `~/.local/bin` instead of `/usr/local/bin` |
| `--sudo` | Use sudo for `/usr/local/bin` symlink AND for the npm install fallback if your prefix needs root |
| `--skip-build` | Skip the workspace build step (re-install on existing checkout) |
| `--no-auto-deps` | Air-gap mode: fail if opencode/cline are missing instead of fetching them |

After installation, run:

```bash
opencode-anycli
```

## Update

```bash
opencode-anycli --update                  # git pull --ff-only + idempotent ./install.sh
opencode-anycli --update --user           # forward extra args to install.sh
opencode-anycli --update --user --sudo    # multiple args also OK
```

`--update` does two things in order:

1. `git pull --ff-only` inside the cloned repo (the directory the running
   binary lives in — auto-discovered by walking up from the symlink target).
   Aborts cleanly with a clear message if the pull would not be a fast-forward
   (uncommitted changes / divergent history / no network).
2. Re-runs `./install.sh` with whatever extra args you passed. The install
   script is idempotent (mtime-based build skip, byte-equal config skip,
   symlink-target-equal skip), so a no-op update completes in under a second
   and produces zero `.bak` files.

## Interactive Subprocesses & sudo

opencode-anycli keeps the cline subprocess's stdin connected to the
parent TTY **by default**, so commands the agent runs can prompt the
user — `sudo`, `ssh-add`, `gh auth login`, `expect`-style flows, etc.
The wrapper does not need a flag for this; it is the default.

```bash
opencode-anycli                # TTY enabled by default
opencode-anycli --no-tty       # opt out (for CI / pipe-fed runs)
OPENCODE_ANYCLI_TTY=0 opencode-anycli   # env-var equivalent of --no-tty
```

Caveats — there are TWO layers below us we cannot directly control:

1. **opencode's bash tool** spawns its own subprocesses. Whether those
   inherit a TTY is opencode's implementation detail.
2. **cline's bash tool** likewise. `--tty` (now the default) gives cline
   itself TTY-stdin; whether cline forwards that to the bash commands it
   runs is cline's call.

If `sudo` still says "no tty" or never prompts (the inner bash tool
doesn't forward stdin), the most reliable fix is a SCOPED NOPASSWD
sudoers entry. The wrapper ships an automated installer:

```bash
opencode-anycli --setup-sudo            # auto-detect distro + interactive confirm
opencode-anycli --setup-sudo --yes      # apply without prompt (CI / fresh box)
opencode-anycli --setup-sudo --print    # show what would be applied, do not write
opencode-anycli --setup-sudo --remove   # remove the rule
opencode-anycli --setup-sudo --for-docker --yes   # also whitelist usermod / systemctl /
                                                  # groupadd / tee / chmod / gpasswd so
                                                  # `--setup-docker` runs unattended
```

It detects your package manager (`apt`/`dnf`/`yum`/`pacman`/`zypper`/`apk`),
writes a scoped `/etc/sudoers.d/opencode-anycli` allowing ONLY those
specific binaries to run without password (never `NOPASSWD: ALL`),
validates with `visudo`, and verifies with `sudo -n -l`. macOS short-
circuits with a no-op message because Homebrew does not need sudo.

`opencode-anycli --doctor` reports whether the rule is installed and active.

Other workarounds for non-package-manager prompts (covered in oh-my-anycli's
`sudo-helper` skill, invoke via `/sudo`):

- **`SUDO_ASKPASS` helper** (GUI password prompt — useful for `ssh-add`)
- **Pre-authorize the sudo cache** (`sudo -v` outside opencode-anycli,
  then start the session within the cache TTL)

## Docker setup (for sandboxed-browser-testing skill)

The oh-my-anycli `sandboxed-browser-testing` skill (`/sandbox`) requires
Docker so browser tests run inside `mcr.microsoft.com/playwright` and
never touch the host browser, profile, or cookies. The wrapper ships an
auto-installer:

```bash
opencode-anycli --setup-docker          # detect distro + install + add to docker group
opencode-anycli --setup-docker --yes    # non-interactive
opencode-anycli --setup-docker --print  # show plan, do not write
```

What it does (Linux only):

1. Detects `apt`/`dnf`/`yum`/`pacman`/`zypper` and installs `docker.io`
   (or `docker`).
2. `sudo systemctl enable --now docker` (when systemd is present).
3. `sudo usermod -aG docker $USER`.
4. Verifies with `docker info`; if the new group membership is not yet
   active in the current shell, prints the exact follow-up:
   `newgrp docker` (or log out / log back in).

macOS short-circuits with a message — Docker on macOS requires Docker
Desktop, Colima, or OrbStack, which the user must install themselves.

If `--setup-docker` prompts for sudo passwords inside an opencode-anycli
session (the cline subprocess often does not forward a TTY), run
`--setup-sudo --for-docker --yes` first to whitelist the system-admin
binaries (`usermod`, `systemctl`, `groupadd`, `tee`, `chmod`, `gpasswd`)
under the same scoped `/etc/sudoers.d/opencode-anycli` rule.

## Auto-approve (Yolo Mode)

opencode itself prompts for approval on file edits, bash commands, web
fetches, external-directory access, and similar gated operations. For long
unattended runs you can silence those prompts wholesale.

### How to enable

Three equivalent ways:

```bash
opencode-anycli --auto-approve     # explicit flag
opencode-anycli --yolo             # alias
opencode-anycli -y                 # short alias

# or, persistent in your shell profile:
export OPENCODE_ANYCLI_AUTO_APPROVE=1
```

When the flag is set, the wrapper materialises a session-scoped temp
config that adds `"allow"` for every documented opencode permission:
`read`, `edit`, `glob`, `grep`, `bash`, `task`, `skill`, `lsp`, `question`,
`webfetch`, `websearch`, `external_directory`, `doom_loop`, plus the
catch-all `*`. Your own explicit `"deny"` rules still win — for example,
`bash: "deny"` in your personal `opencode.json` keeps blocking bash even
with `--auto-approve`. The temp file is cleaned up on session exit
(`exit`, `SIGINT`, `SIGTERM`).

The cline subprocess is already invoked with `--yolo` by the provider, so
the inner cline layer is unaffected by this flag — auto-approve here only
silences the **outer opencode** layer that you actually see prompts from.

### What it does NOT do

- It does **not** toggle at runtime. opencode loads permissions at session
  start and does not watch the config file. To turn auto-approve on or
  off, exit and relaunch with (or without) the flag.
- It does **not** override your explicit `"deny"` rules in your own
  config — those keep blocking the relevant tool.
- It does **not** suppress cline's auto-update / telemetry — those are
  separate cline-internal behaviours (see `docs/troubleshooting.md`).

### Safety

`--auto-approve` removes a deliberate safety net. Use it only when:

- you are working in a throwaway directory or a fresh git branch with
  frequent commits;
- the project has tests or another verifiable success criterion;
- you will review the diff before pushing.

Do **not** use it on production credentials, shared machines, or the first
session you open in an unfamiliar repo.

## Uninstall

```bash
./uninstall.sh                 # remove the opencode-anycli symlink only
./uninstall.sh --purge-config  # also remove ~/.config/opencode-anycli/
./uninstall.sh --purge-build   # also remove dist/ + node_modules/
./uninstall.sh --purge-all     # both of the above
./uninstall.sh --yes           # skip confirmation prompts
```

The uninstaller never touches `opencode`, `cline`, `~/.cline/`, or your standard
`~/.config/opencode/` — only what `install.sh` placed.

## Architecture

```text
opencode -> provider-cline-cli -> cline CLI -> configured model
   ^              |                  |
   |              +-- NDJSON parse <--+
   +---------------- assistant text
```

The adapter implements the Vercel AI SDK v3 `LanguageModelV3` interface expected by opencode. It starts cline as a subprocess, parses cline's NDJSON event stream, and returns the final assistant text to opencode.

## Modes

- `subprocess`: implemented. Uses cline as a subprocess and preserves cline tool behavior.
- `passthrough`: planned. Would read cline settings and call the model directly from opencode.

## Companion Project

[oh-my-anycli](https://github.com/JSUYA/oh-my-anycli) adds reusable skills, slash commands, subagents, and plugins on top of opencode-anycli.

## Documentation

- [Installation](./docs/installation.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Provider modes](./docs/provider-modes.md)
- [Troubleshooting](./docs/troubleshooting.md)

## License

MIT. opencode and cline are separate projects with their own licenses.
