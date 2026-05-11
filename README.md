# OpenCode-AnyCLI

> Run the opencode AI coding agent through your locally installed cline CLI.

OpenCode-AnyCLI installs a small opencode adapter that forwards model requests to `cline --json --yolo --act <prompt>`. cline keeps using the model, credentials, and tool behavior the user has already configured.

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

OpenCode-AnyCLI does not improve model quality by itself; cline still uses the same configured model. The advantage is that coding work runs inside opencode's project-oriented workflow instead of a raw one-shot CLI prompt.

- **Better codebase navigation:** use opencode's TUI, session context, and file-aware workflow while delegating model calls to cline.
- **More structured implementation:** feature work can be handled as inspect -> plan -> edit -> verify instead of a single loose prompt.
- **More reliable debugging:** runtime failures can be analyzed through code-path tracing, ranked hypotheses, minimal fixes, and follow-up tests.
- **Config isolation:** OpenCode-AnyCLI keeps its opencode config, skills, commands, and agents under `~/.config/opencode-anycli` instead of mixing them with a user's normal opencode setup.
- **Workflow extension point:** Oh-My-AnyCLI can add reusable slash commands, skills, and subagents on top of the same cline-backed model path.

For tiny edits or quick questions, direct cline CLI can still be faster. OpenCode-AnyCLI is most useful when the coding task benefits from navigation, repeatable process, and verification.

## Prerequisites

| Tool | Required version | Why |
|---|---|---|
| **Node.js** | **≥ 20** (`node -v`) | Enforced by `install.sh` and the `engines` field in every workspace `package.json`. Build target is `node20`. |
| **npm** | bundled with Node 20+ (≥ 10) | Used to install `opencode-ai`, `cline`, and `typescript-language-server` globally, and to run the workspace build. |
| **git** | any recent version | Required to `git clone` the repo and for `opencode-anycli --update`. |
| **bun** | optional | If present, `install.sh` uses `bun install` + `bun run build` instead of npm. Falls back to npm cleanly when absent. |
| OS | Linux or macOS | `install.sh` refuses other platforms. |

If you're on Node 18 or older, upgrade first — `install.sh` will refuse to
run otherwise. Quickest path:

```bash
# nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20 && nvm use 20

# or NodeSource (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

After upgrading, `node -v` should report `v20.x` (or newer) before
continuing.

## Install

```bash
git clone https://github.com/JSUYA/opencode-anycli.git
cd opencode-anycli
./install.sh && source ~/.bashrc      # bash; for zsh use ~/.zshrc
opencode-anycli
```

The `&& source ~/.bashrc` makes the new PATH live in the current shell
right away — without it, `opencode-anycli` won't be found until you open
a new terminal. install.sh prints the exact source command for your
detected shell at the very end, so you can copy-paste it if you forget
to chain it.

`opencode` and `cline` are treated as **bundled runtime dependencies of
OpenCode-AnyCLI** — if either is missing on `PATH`, the installer fetches
it for you via `npm install -g` (no extra flag required). Conceptually,
`opencode-anycli` IS opencode + cline + our provider/config wired
together; the three pieces just happen to ship as separate npm packages
upstream.

`install.sh` does **not** drop a symlink into `/usr/local/bin` or
`~/.local/bin` anymore. Instead it appends a managed `export PATH=...`
block to your shell rc file (`.bashrc`, `.zshrc`, or the fish config),
pointing at `<repo>/packages/cli/bin/`. The block is bracketed by
`# >>> opencode-anycli (managed by install.sh) >>>` markers so re-runs
update it in place rather than duplicating it, and `./uninstall.sh`
strips the same block out cleanly. Pulling the repo (or `--update`)
takes effect immediately — no relink step needed.

Optional flags:

| Flag | When to use |
|---|---|
| `--skip-build` | Skip the workspace build step (re-install on existing checkout) |
| `--no-auto-deps` | Air-gap mode: fail if opencode/cline are missing instead of fetching them |
| `--no-lsp-deps` | Skip auto-install of `typescript-language-server` (otherwise installed so the right-hand LSP panel populates for `.ts`/`.tsx`/`.js` files) |
| `--user` / `--sudo` | DEPRECATED no-ops — kept so existing `opencode-anycli --update --user` invocations don't break. The PATH-based install never needs sudo and never writes outside your home. |

## Update

```bash
opencode-anycli --update                  # auto-stash + git pull + idempotent ./install.sh + stash pop
opencode-anycli --update --skip-build     # forward extra args to install.sh
```

`--update` does the following, in order:

1. `git status --porcelain` — if your working tree has uncommitted
   changes (tracked or untracked), they are automatically stashed under
   the message `opencode-anycli auto-stash <ISO ts>` so the fast-forward
   pull can proceed without complaint.
2. `git pull --ff-only` inside the cloned repo (the directory the
   running binary lives in — auto-discovered by walking up from the
   `opencode-anycli` script). Aborts cleanly with a clear message if
   the pull would not be a fast-forward.
3. Re-runs `./install.sh` with whatever extra args you passed. The
   install script is idempotent (mtime-based build skip, byte-equal
   config skip, marker-aware PATH-block skip), so a no-op update
   completes in under a second and produces zero `.bak` files.
4. `git stash pop` — restores the stashed changes back onto the freshly
   pulled tree. If pop conflicts, the stash is left at `stash@{0}` and
   the script tells you exactly which commands to run to recover, so
   nothing is silently dropped.

## Interactive Subprocesses & sudo

OpenCode-AnyCLI keeps the cline subprocess's stdin connected to the
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

If `sudo` inside an agent run still says "no tty" or hangs (the inner
bash tool doesn't forward stdin), see **Allow Dangerously Skip
Permissions** below — one flag, one prompt at startup, no persistent
sudoers / system changes.

## Allow Dangerously Skip Permissions

When the agent needs to install packages, start daemons, run Docker, or
otherwise act as root, **one flag** flips the whole session into
elevated mode:

```bash
opencode-anycli --allow-dangerously-skip-permissions
opencode-anycli --dangerously-skip-permissions      # alias
OPENCODE_ANYCLI_DANGEROUS=1 opencode-anycli         # env-var equivalent
```

What it does:

1. Re-execs the entire OpenCode-AnyCLI process under `sudo -E`.
   You enter your password **once**, at startup. From that moment on,
   opencode + cline + every subprocess they spawn run as root, so the
   agent can call `apt install`, `systemctl`, `docker pull`, `usermod`,
   etc. without ever hitting another prompt.
2. Implies `--auto-approve`, so opencode's own per-tool permission
   prompts are also silenced for the session.
3. Writes **nothing** to `/etc/sudoers.d/`, edits **no** system
   configuration, and exits cleanly when the session ends. There is no
   persistent privilege change to roll back.

Trade-offs (this is why "dangerously" is in the name — opt in
deliberately):

- Files the agent creates during the session will be **root-owned**.
  `chown -R "$USER":"$USER" .` afterwards if that bothers a
  follow-up build.
- The agent has full root for the session — only use this when you
  trust its action set, and prefer running in a disposable VM /
  container / fresh checkout when you want stronger isolation.
- If `sudo` is not on `PATH`, the flag refuses to run with a clear
  message instead of silently degrading.

`opencode-anycli --doctor` reports whether `sudo` is available so the
flag will work.

## Ctrl+C handling (exit-confirm dialog)

Pressing **Ctrl+C** inside the opencode TUI no longer exits immediately.
Instead an `Exit opencode-anycli?` confirmation dialog appears with
**Confirm** focused — press **Enter** to exit, **Escape** (or arrow to
**Cancel** + Enter) to keep the session open. A second Ctrl+C while the
dialog is open is suppressed by opencode's dialog layer; use Enter or
Escape to dismiss.

This is implemented as an opencode TUI plugin shipped with this project
(`packages/tui-plugin-exit-confirm`) and registered automatically by the
`tui.json` that `install.sh` writes alongside `opencode.json`. The
plugin works by:

1. Rebinding opencode's `app_exit` keybind to drop `ctrl+c` so the
   built-in exit-on-Ctrl+C handlers stop firing.
2. Attaching a global handler to opentui's renderer-level `keyInput`
   emitter that fires before any component-level handler. When it sees
   `ctrl+c` (without other modifiers) it opens the dialog and calls
   `evt.preventDefault()` to stop propagation, so opencode's session /
   prompt routes never see the event.
3. On confirm, calling `api.command?.trigger("app.exit")` to reuse the
   exact shutdown path opencode uses for its own exit (renderer
   teardown, terminal-title reset, etc.).

(Earlier versions of this plugin hooked into the unused
`username_toggle` keybind name. opencode 1.14 dropped that name and
made the `tui.json` schema strict — `additionalProperties: false` —
so any stale reference silently invalidated the whole file and dropped
every keybind override with it. The raw-keypress approach above is
schema-independent and survives future keybind renames.)

To revert to opencode's default Ctrl+C-exits behaviour: delete
`~/.config/opencode-anycli/opencode/tui.json` (or remove the
`plugin: [...]` entry inside it).

## Multi-line prompt — Enter inserts a newline, Alt+Enter / Ctrl+Enter / Ctrl+J submit

opencode's upstream default is the messenger pattern (Enter submits,
Shift+Enter inserts a newline). That relies on the terminal reporting
the **Shift** modifier on Return — which only works when both:
(a) the terminal speaks either the kitty keyboard protocol or xterm's
`modifyOtherKeys` extension, and (b) it actually reports modifiers on
the Return key (some implement modifyOtherKeys but exclude Return for
backward compatibility). On terminals that fail either bar — default
xterm-256color in many environments, basic SSH chains, embedded
IDE terminals, older gnome-terminal, etc. — Shift+Enter arrives at
opencode as bare `\r`, indistinguishable from plain Enter. The prompt
then submits when the user expected a newline.

OpenCode-AnyCLI ships a `tui.json` that flips the model: plain Enter
always inserts a newline, and three different keys can submit so at
least one works in any terminal / window manager.

```jsonc
// templates/tui.json (installed at ~/.config/opencode-anycli/opencode/tui.json)
{
  "keybinds": {
    "prompt_submit": "alt+return,ctrl+return,ctrl+j",
    "input_submit":  "alt+return,ctrl+return,ctrl+j",
    "input_newline": "return,shift+return"
  }
}
```

Why both `prompt_submit` and `input_submit`: opencode 1.14+ split
submit handling into two keybinds — `prompt_submit` is the main
LLM-prompt textarea, `input_submit` is dialogs / search / other input
fields. Overriding only one leaves the other on its default (Enter
submits), which is what you'll see after upgrading an older config.

Result:

| Key | Action | Works in |
|---|---|---|
| **Enter** | Insert newline | every terminal — bare `\r` isn't bound to any submit keybind, so the textarea inserts a newline by default |
| **Alt+Enter** (Option+Enter on macOS) | Submit prompt | every common terminal that doesn't intercept Alt+Return — sends `\x1b\r`, an emacs-era universal Meta-prefix sequence. Window managers like Enlightenment's Terminology or GNOME's "use Alt to access menus" can swallow it; in that case use Ctrl+J |
| **Ctrl+Enter** | Submit prompt | terminals that report the Ctrl modifier on Return: ghostty, kitty, WezTerm, recent alacritty, foot, iTerm2 (Settings → Profiles → Keys → "Report modifiers using CSI u"). On other terminals Ctrl+Enter arrives as bare `\r` and falls through to newline |
| **Ctrl+J** | Submit prompt | **every terminal, every WM** — sends `\n` (ASCII LF, 0x0A), a pure ASCII byte no terminal or window manager intercepts. The universal fallback when Alt+Enter is blocked and the terminal doesn't speak kitty / modifyOtherKeys |
| Shift+Enter | Newline (when terminal reports the modifier; otherwise falls through to plain Enter → still newline) | all terminals (graceful degradation) |

Why this is safe regardless of terminal capability: every supported
"submit" key either reaches opencode as a unique sequence (`\x1b\r`,
`\n`, `\x1b[13;5u`) that matches one of the submit keybinds, or
collapses to bare `\r` on a terminal that strips the modifier — and
bare `\r` is not bound to submit, so it inserts a newline. You can't
accidentally submit by pressing the wrong combination; you can only
fail to submit and get a newline, which the textarea handles fine.

UX trade-off: this is the "Cursor / VS Code chat / WhatsApp Web"
pattern, not the "Slack / Discord" pattern. If you prefer upstream's
default (Enter submits) and your terminal does report Shift+Enter,
edit `~/.config/opencode-anycli/opencode/tui.json` and change the
keybinds back to opencode's defaults
(`"prompt_submit": "return"`, `"input_submit": "return"`,
`"input_newline": "shift+return,ctrl+return,alt+return,ctrl+j"`).
The wrapper still enables `modifyOtherKeys` mode 2 at startup either
way, so terminals that DO support it will pick up the modifier on
Shift+Enter regardless of which preset you use.

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

The adapter implements the Vercel AI SDK v3 `LanguageModelV3` interface expected by opencode. It starts cline as a subprocess, parses cline's NDJSON event stream, forwards cline's visible reasoning/text/output events, and reports token/cache usage from cline events or persisted task state.

## Modes

- `subprocess` (default): spawns `cline --json --yolo --act <prompt>`. Simple
  and proven, but the prompt is a single positional argument so the kernel
  argv limit (`ARG_MAX` — typically 256 KiB on macOS, 4 MiB on Linux) caps
  how much conversation can be passed. Long sessions or large pasted file
  context eventually trip `Failed to spawn cline: spawn E2BIG`.
- `acp` (opt-in): spawns `cline --acp` and speaks the
  [Agent Client Protocol](https://agentclientprotocol.com) over stdio JSON-RPC.
  The prompt travels in the message body, not argv, so `ARG_MAX` does not
  apply — long inputs are bounded only by cline's internal limits and
  available memory. Recommended whenever you hit `E2BIG` or expect
  conversation history to grow large.
- `passthrough` (planned): would read cline settings and call the model
  directly from opencode. Not yet implemented.

To opt into ACP mode, set `mode: "acp"` on the cline provider in
`~/.config/opencode-anycli/opencode/opencode.json`:

```json
{
  "provider": {
    "cline": {
      "options": { "mode": "acp" }
    }
  }
}
```

ACP requires cline ≥ 2.18 (which ships `--acp`). Verified against
prompts up to ~2 MiB; above that cline's internal model context window
becomes the limiting factor, not the transport.

## Diagnostics & recovery

```bash
opencode-anycli --doctor      # read-only diagnostic
opencode-anycli --fix         # interactive recovery (each step prompts)
opencode-anycli --fix-yes     # --fix with auto-confirm (CI / scripts)
```

`--doctor` reports node / opencode / cline versions, the LSP panel
prerequisites, and now also flags two known startup blockers:

- foreign-owned files inside `~/.local/share/opencode/`,
  `~/.config/opencode-anycli/`, or `~/.cline/data/` (almost always
  left over from a past `--allow-dangerously-skip-permissions`
  session that ran the whole TUI as root with `HOME=$HOME`); and
- a corrupt opencode SQLite database — the symptom users actually
  see is the `DrizzleError: Failed to run the query 'PRAGMA
  wal_checkpoint(PASSIVE)'` JSON dump on startup.

`--fix` walks each detected case in turn with a single `[y/N]`
prompt: `sudo chown -R` to reclaim ownership, and a backup-then-move
on the broken `opencode.db` (no session history is silently
deleted; the file is preserved as `opencode.db.broken.<ts>` and
opencode regenerates an empty DB on the next launch). It also
covers the npm cache pollution case (`~/.npm/_cacache` entries
owned by root — typically blocks `npm install` inside `install.sh`).

## Companion Project

[Oh-My-AnyCLI](https://github.com/JSUYA/oh-my-anycli) adds reusable skills, slash commands, subagents, and plugins on top of OpenCode-AnyCLI.

## Documentation

- [Installation](./docs/installation.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Provider modes](./docs/provider-modes.md)
- [Troubleshooting](./docs/troubleshooting.md)

## License

MIT. opencode and cline are separate projects with their own licenses.
