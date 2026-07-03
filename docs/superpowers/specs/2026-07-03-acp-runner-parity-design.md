# ACP Runner Parity + Version-Based Mode Auto-Selection — Design

**Date:** 2026-07-03
**Status:** Approved (brainstorming complete)
**Package:** `packages/provider-cline-cli`

## Problem

`opencode-anycli` drives the Samsung `cline-sr` CLI. Two transports exist:

- **subprocess** (`cline --json --yolo -m <model> --act <prompt>`): full native-tool
  bridging (read/bash/edit/write/grep) via `cline-runner.ts`. Prompt rides on
  argv (temp-file spill for large prompts).
- **ACP** (`cline --acp`, Agent Client Protocol over stdio JSON-RPC): prompt
  travels in the JSON-RPC body — no argv ceiling, so it handles arbitrarily
  large context, which is the motivation for using it.

The CLI surface differs by cline-sr version:

| | cline-sr **0.5.1** | cline-sr **0.6.0** |
|---|---|---|
| `--acp` flag | present, ACP works | removed (ignored → interactive TTY error) |
| `--yolo` / `--act` | present | removed (ignored; positional prompt + default auto-approve) |
| subprocess tool schema | legacy `say.tool` / `say.command` | `agent_event` `content_start/end` `contentType:"tool"` |

The current ACP runner (`cline-acp-runner.ts`) is a second-class citizen:

1. **Tool bridging incomplete** — `translateSessionUpdate` only bridges `read`
   (`pickReadFilePath`); `execute`/bash, `edit`, `write`, `search` are dropped
   → invisible in opencode.
2. **Reasoning leaks** — `agent_thought_chunk` is emitted as visible
   `text-delta`, polluting the answer; assistant text is also duplicated.
3. **Usage is always 0** — no token/context reporting → opencode context panel
   shows 0%.
4. **Mode is a static config value** — the user must hand-edit `mode` and know
   which cline version supports ACP.

## Goals

- Bring the ACP runner to subprocess-level tool bridging (all tools, structured
  V3 tool-call/result parts — the OpenAI-function-call shape opencode expects).
- Route cline reasoning to a proper V3 reasoning stream part.
- Best-effort usage recovery in ACP mode.
- Auto-select transport at runtime by detecting cline's `--acp` capability, so
  0.5.1 → ACP and 0.6.0 → subprocess with no manual config.

## Non-Goals

- **Passthrough mode** (bypass cline, call the model API directly via cline's
  stored OpenAI-compatible credentials) — separate large effort, out of scope.
- Changing subprocess-mode behavior beyond what parity/shared-code requires.

## Design

### Component 1 — Runtime mode auto-detection

- Add `"auto"` to `ClineMode` (`types.ts`).
- New `cline-capabilities.ts`:
  ```ts
  detectAcpSupport(command: string): Promise<boolean>
  ```
  Spawns `<command> --help`, checks stdout/stderr for a `--acp` token
  (`/(^|\s)--acp(\s|$)/`). Result cached module-level in
  `Map<string, Promise<boolean>>` (one probe per command per process). On
  spawn error / timeout (~5s) → `false` (subprocess is the safe fallback).
  **Capability detection, not version-string matching** — 0.5.1 has `--acp`
  (→ ACP), 0.6.0 does not (→ subprocess); robust to future versions.
- `language-model.ts` resolves the effective mode: `"acp"` / `"subprocess"` /
  `"passthrough"` honored verbatim; `"auto"` (and the default) → `await
  detectAcpSupport(command)` picks `acp` vs `subprocess`. Applies to both
  `doGenerate` and `doStream`, cline flavor only (claude/codex unaffected).
- `templates/opencode.json`: cline `options.mode` → `"auto"`.
- `install.sh`: migrate an existing cline `options.mode == "subprocess"` (the
  value we previously shipped as default) to `"auto"`, mirroring the existing
  model-id migration. A user-chosen explicit `"acp"`/`"subprocess"` set after
  this change is preserved (documented caveat: the migration only rewrites our
  old shipped default).

### Component 2 — ACP tool bridging parity

- New `bridgeAcpTool(kind, rawInput, rawOutput)` in `cline-tool-bridge.ts`
  returning the existing bridged shape (`toolName`, `input`, `result`, `ok`).
  Map by ACP `ToolKind`:

  | ACP `kind` | opencode tool | args source |
  |---|---|---|
  | `read` | `read` | `rawInput.path`/`filePath`, `locations[].path` |
  | `execute` | `bash` | `rawInput.command` |
  | `edit` | `edit` or `write` | `rawInput.path` + `diff`/`new_text`/`content` (edit when `old_text`/`diff` present, else write) |
  | `search` | `grep` | `rawInput.regex`/`query`/`pattern` |
  | other | `cline:<kind>` → text fallback | — |

  Reuse `pickString` / outcome-normalization helpers already added for
  `bridgeAgentEventTool`.
- `cline-acp-runner.ts` `translateSessionUpdate`: replace the read-only
  `tool_call`/`tool_call_update` handling with:
  - Track `Map<toolCallId, { toolName, input }>`.
  - On `tool_call` (or first update carrying `kind` + `rawInput`): bridge and
    enqueue a `tool-call` StreamEvent; stash by `toolCallId`.
  - On `tool_call_update` with `status` `completed`/`failed` carrying
    `rawOutput`/`content`: enqueue a `tool-result` StreamEvent (`isError` when
    `failed`); clear the stash entry.
  - Ignore empty streaming `tool_call_update`s (no `kind`, no terminal status).
  - Keep the `emittedReads` de-dupe and the prompt-spill suppression parity.
  - Unknown/unmapped kinds → text-delta fallback marker (opencode drops
    unregistered tool names).
- `language-model.ts` `doStream` already forwards runner `tool-call` /
  `tool-result` events as `providerExecuted: true`; no change needed there for
  ACP tools (same StreamEvent contract as subprocess).

### Component 3 — Reasoning, usage, dedup

- **Reasoning:** add `{ type: "reasoning-delta"; delta: string }` to the
  runner `StreamEvent` union. ACP `agent_thought_chunk` → `reasoning-delta`
  (was `text-delta`). `doStream` opens a lazy reasoning block
  (`reasoning-start` / `reasoning-delta` / `reasoning-end`) mirroring the
  existing text-block open/close, closing it before any text or tool-call
  part. `runOnceAcp` drops reasoning from `finalText` (thoughts are not the
  answer). Subprocess runner behavior unchanged (scope containment).
- **Usage:** reuse `readPersistedTaskUsage` from `cline-runner.ts` (export it).
  Recover cline's internal task id for the ACP session (from `~/.cline-sr`
  `tasks/` — newest task dir, or a session→task mapping file), read
  `ui_messages.json` tokens, attach to the ACP `finish` event. On mapping
  failure → usage stays 0 (current behavior; no regression). **Risk:**
  sessionId↔taskId mapping is not guaranteed; treat as best-effort.
- **Dedup:** after reasoning is split off, re-verify the answer text. If
  `agent_message_chunk` still duplicates the final `attempt_completion`,
  strengthen the existing `assistantState` prefix/exact dedup.

### Component 4 — Tests

- `bridgeAcpTool` unit tests using real captured ACP `rawInput` shapes
  (`readFile`, `execute`/`echo`, `editor`, `search`).
- ACP runner tests: a fake ACP `Client`/connection feeding `tool_call` /
  `tool_call_update` / `agent_thought_chunk` / `agent_message_chunk` updates,
  asserting emitted `tool-call` / `tool-result` / `reasoning-delta` /
  `text-delta` StreamEvents (analogous to the subprocess fake-spawn tests).
- `detectAcpSupport` tests with fake `--help` output (with / without `--acp`).
- Live verification on cline 0.5.1: ACP read+bash+edit bridged; opencode
  `run --format json` headless end-to-end (same method used to verify the
  subprocess fix).

## Files

| File | Change |
|---|---|
| `src/types.ts` | `ClineMode` + `"auto"`; `StreamEvent` + `reasoning-delta` |
| `src/cline-capabilities.ts` | **new** — `detectAcpSupport` (cached `--help` probe) |
| `src/cline-tool-bridge.ts` | `bridgeAcpTool` |
| `src/cline-acp-runner.ts` | full tool bridging + reasoning + usage in `translateSessionUpdate` |
| `src/cline-runner.ts` | export `readPersistedTaskUsage` |
| `src/language-model.ts` | resolve `auto` mode; handle `reasoning-delta` in `doStream` |
| `templates/opencode.json` | cline `mode: "auto"` |
| `install.sh` | migrate old `mode:"subprocess"` → `"auto"` |
| `docs/provider-modes.md` | document `auto` mode + version behavior |
| `test/*` | bridge/runner/capability/reasoning tests |

## Risks & Mitigations

- **sessionId↔taskId mapping (usage):** best-effort; falls back to 0. No
  regression vs today.
- **`install.sh` mode migration:** only rewrites our previously-shipped
  `"subprocess"` default; a user who deliberately set `"subprocess"` after this
  ships would be flipped to `auto` — acceptable since `auto` picks subprocess on
  0.6.0 anyway, and `auto` on 0.5.1 is the desired behavior. Documented.
- **`--acp` present but ACP handshake broken on some build:** detection is
  capability-only. If a future build advertises `--acp` but its ACP is
  incompatible, ACP would fail. Mitigation: ACP runner already surfaces a hard
  error; user can pin `mode:"subprocess"`.
- **opencode drops unregistered tool names:** bridge maps strictly to
  read/write/edit/bash/grep; unknowns fall back to text.

## Verification / Success Criteria

- cline 0.5.1: `mode` unset/`auto` → ACP selected; read+bash+edit surface as
  completed provider-executed tool parts in opencode; reasoning shows as
  thinking (not answer text); answer text is not duplicated.
- cline 0.6.0: `mode` unset/`auto` → subprocess selected; existing behavior
  intact.
- Full `vitest` suite green; typecheck clean; dist rebuilt.
