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
