# ACP Runner Parity + Version-Based Mode Auto-Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the ACP runner to subprocess-level tool bridging, route cline reasoning to V3 reasoning parts, recover ACP usage best-effort, and auto-select ACP vs subprocess by detecting cline's `--acp` capability at runtime.

**Architecture:** Add a cached `--help` capability probe (`cline-capabilities.ts`); a `bridgeAcpTool` mapper (`cline-tool-bridge.ts`) reused by a rewritten `translateSessionUpdate` in `cline-acp-runner.ts` that emits structured tool-call/result + `reasoning-delta` StreamEvents; `language-model.ts` resolves `mode:"auto"` via the probe and renders `reasoning-delta` as V3 reasoning parts.

**Tech Stack:** TypeScript (ESM, node20), Vitest, `@ai-sdk/provider` V3, `@agentclientprotocol/sdk`, tsup.

## Global Constraints

- Package dir: `packages/provider-cline-cli`. All paths below are relative to it unless noted.
- ESM only; import paths carry `.js` extension. `unknown` over `any`; hand-rolled type guards.
- opencode silently DROPS `tool-call` stream parts whose `toolName` is not in its registry — bridged names MUST be one of: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `webfetch`, `websearch`. Unknown → text fallback.
- All bridged cline tools are provider-executed (cline already ran them); `language-model.ts` marks them `providerExecuted: true`.
- cline binary is Samsung `cline-sr`: 0.5.1 has `--acp`, 0.6.0 removed it. Detection is capability-based (`--acp` present in `--help`), NOT version-string matching.
- Build/typecheck offline: run `../../node_modules/.bin/tsup` and `../../node_modules/.bin/tsc --noEmit` directly (pnpm scripts fail on the network deps-check). Tests: `pnpm vitest run` works.
- opencode loads the provider from `dist/index.js`; rebuild dist after src changes.
- ACP enums (from `@agentclientprotocol/sdk`): `ToolCallStatus` = `pending|in_progress|completed|failed`; `ToolKind` = `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`; `ToolCallContent` variants = `content|diff|terminal`.

---

### Task 1: `bridgeAcpTool` — map ACP tool events to opencode tools

**Files:**
- Modify: `src/cline-tool-bridge.ts` (append near `bridgeAgentEventTool`)
- Test: `test/cline-acp-tool-bridge.test.ts` (create)

**Interfaces:**
- Consumes: existing `isObject`, `pickString` helpers in `cline-tool-bridge.ts`.
- Produces:
  - `bridgeAcpTool(kind: string | undefined, rawInput: unknown): { toolName: string; input: Record<string, unknown> } | null` — maps an ACP tool-call to an opencode tool-call input. Returns `null` for unmappable kinds (caller emits a text fallback).
  - `buildAcpToolResult(toolName: string, rawOutput: unknown, contentText: string | null, ok: boolean): Record<string, unknown>` — builds the tool-result body; `bash` output goes under `stdout`, everything else under `output`.

- [ ] **Step 1: Write the failing test**

Create `test/cline-acp-tool-bridge.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { bridgeAcpTool, buildAcpToolResult } from "../src/cline-tool-bridge.js"

describe("bridgeAcpTool", () => {
  it("maps read (rawInput.path) to opencode read", () => {
    const b = bridgeAcpTool("read", { tool: "readFile", path: "/tmp/a.txt" })
    expect(b).toEqual({ toolName: "read", input: { filePath: "/tmp/a.txt" } })
  })

  it("maps execute (rawInput.command) to opencode bash", () => {
    const b = bridgeAcpTool("execute", { command: "echo hi" })
    expect(b).toEqual({ toolName: "bash", input: { command: "echo hi" } })
  })

  it("maps edit with new_text only to write", () => {
    const b = bridgeAcpTool("edit", { path: "/tmp/a.txt", new_text: "BODY" })
    expect(b).toEqual({ toolName: "write", input: { filePath: "/tmp/a.txt", content: "BODY" } })
  })

  it("maps edit with old_text to edit (in-place)", () => {
    const b = bridgeAcpTool("edit", { path: "/tmp/a.txt", old_text: "X", new_text: "Y" })
    expect(b).toEqual({ toolName: "edit", input: { filePath: "/tmp/a.txt", oldString: "X", newString: "Y" } })
  })

  it("maps search to grep", () => {
    const b = bridgeAcpTool("search", { regex: "foo", path: "src" })
    expect(b).toEqual({ toolName: "grep", input: { pattern: "foo", path: "src" } })
  })

  it("returns null for unmapped kinds", () => {
    expect(bridgeAcpTool("think", {})).toBeNull()
    expect(bridgeAcpTool(undefined, {})).toBeNull()
  })

  it("returns null when required field is missing", () => {
    expect(bridgeAcpTool("read", {})).toBeNull()
    expect(bridgeAcpTool("execute", {})).toBeNull()
  })

  it("builds bash result with stdout and non-bash with output", () => {
    expect(buildAcpToolResult("bash", "OUT\n", null, true)).toEqual({ ok: true, stdout: "OUT\n" })
    expect(buildAcpToolResult("read", { result: "FILE" }, null, true)).toEqual({ ok: true, output: "FILE" })
    expect(buildAcpToolResult("bash", undefined, null, false)).toEqual({ ok: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run cline-acp-tool-bridge`
Expected: FAIL — `bridgeAcpTool is not a function` / `buildAcpToolResult is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/cline-tool-bridge.ts` (after the `bridgeEditor` block / helpers; `isObject` and `pickString` already exist in the file):

```ts
// ─── ACP (Agent Client Protocol) tool bridging ───────────────────────────────
//
// cline --acp emits tool activity as ACP `tool_call` / `tool_call_update`
// session updates carrying `kind` (ToolKind), `rawInput` (cline's native
// args), `rawOutput`, `content`, and `status`. `bridgeAcpTool` maps the
// call to an opencode tool-call input; `buildAcpToolResult` shapes the
// result body once a terminal status arrives.

/** Map an ACP tool-call (kind + rawInput) to an opencode tool-call, or null. */
export function bridgeAcpTool(
  kind: string | undefined,
  rawInput: unknown,
): { toolName: string; input: Record<string, unknown> } | null {
  const inRec = isObject(rawInput) ? rawInput : {}
  switch (kind) {
    case "read": {
      const filePath = pickString(inRec["path"]) ?? pickString(inRec["filePath"])
      if (filePath === null) return null
      return { toolName: "read", input: { filePath } }
    }
    case "execute": {
      const command = pickString(inRec["command"]) ?? pickString(inRec["cmd"])
      if (command === null) return null
      return { toolName: "bash", input: { command } }
    }
    case "edit": {
      const filePath = pickString(inRec["path"]) ?? pickString(inRec["filePath"])
      if (filePath === null) return null
      const newText = pickString(inRec["new_text"]) ?? pickString(inRec["content"]) ?? pickString(inRec["newText"])
      const oldText = pickString(inRec["old_text"]) ?? pickString(inRec["oldText"])
      const diff = pickString(inRec["diff"])
      if (oldText !== null || diff !== null) {
        const input: Record<string, unknown> = { filePath }
        if (oldText !== null) input["oldString"] = oldText
        if (newText !== null) input["newString"] = newText
        if (diff !== null) input["diff"] = diff
        return { toolName: "edit", input }
      }
      const input: Record<string, unknown> = { filePath }
      if (newText !== null) input["content"] = newText
      return { toolName: "write", input }
    }
    case "search": {
      const pattern = pickString(inRec["regex"]) ?? pickString(inRec["query"]) ?? pickString(inRec["pattern"])
      if (pattern === null) return null
      const input: Record<string, unknown> = { pattern }
      const path = pickString(inRec["path"])
      if (path !== null) input["path"] = path
      return { toolName: "grep", input }
    }
    default:
      return null
  }
}

/** Build the opencode tool-result body for a terminal ACP tool-call. */
export function buildAcpToolResult(
  toolName: string,
  rawOutput: unknown,
  contentText: string | null,
  ok: boolean,
): Record<string, unknown> {
  const text = pickAcpOutputText(rawOutput, contentText)
  const result: Record<string, unknown> = { ok }
  if (text !== null) result[toolName === "bash" ? "stdout" : "output"] = text
  return result
}

function pickAcpOutputText(rawOutput: unknown, contentText: string | null): string | null {
  if (typeof rawOutput === "string" && rawOutput.length > 0) return rawOutput
  if (isObject(rawOutput)) {
    const t =
      pickString(rawOutput["result"]) ??
      pickString(rawOutput["output"]) ??
      pickString(rawOutput["stdout"]) ??
      pickString(rawOutput["content"])
    if (t !== null) return t
  }
  return contentText
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run cline-acp-tool-bridge`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cline-tool-bridge.ts test/cline-acp-tool-bridge.test.ts
git commit -m "feat(provider): add bridgeAcpTool for ACP tool-call mapping"
```

---

### Task 2: `detectAcpSupport` — cached `--acp` capability probe

**Files:**
- Create: `src/cline-capabilities.ts`
- Test: `test/cline-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `detectAcpSupport(command: string, spawnFn?: typeof import("node:child_process").spawn): Promise<boolean>` — true iff `<command> --help` output contains a `--acp` token. Cached per `command`. Errors/timeout → `false`.
  - `clearAcpSupportCache(): void` — test seam / cache reset.

- [ ] **Step 1: Write the failing test**

Create `test/cline-capabilities.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { detectAcpSupport, clearAcpSupportCache } from "../src/cline-capabilities.js"

function fakeHelp(stdout: string, code = 0) {
  return ((_cmd: string, _args?: readonly string[], _opts?: object) => {
    const p = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean }
    p.stdout = new Readable({ read() {} })
    p.stderr = new Readable({ read() {} })
    p.kill = () => true
    setTimeout(() => {
      p.stdout.push(stdout)
      p.stdout.push(null)
      p.stderr.push(null)
      setTimeout(() => p.emit("close", code, null), 2)
    }, 0)
    return p as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import("node:child_process").spawn
}

describe("detectAcpSupport", () => {
  beforeEach(() => clearAcpSupportCache())

  it("returns true when --help lists --acp", async () => {
    const help = "Options:\n  --json\n  --acp   Run in ACP mode\n  --tui\n"
    expect(await detectAcpSupport("cline", fakeHelp(help))).toBe(true)
  })

  it("returns false when --help has no --acp", async () => {
    const help = "Options:\n  --json\n  --auto-approve <boolean>\n"
    expect(await detectAcpSupport("cline", fakeHelp(help))).toBe(false)
  })

  it("caches the result per command (probe runs once)", async () => {
    let calls = 0
    const counting = ((c: string, a?: readonly string[], o?: object) => {
      calls++
      return (fakeHelp("  --acp\n") as unknown as (c: string, a?: readonly string[], o?: object) => ChildProcessWithoutNullStreams)(c, a, o)
    }) as unknown as typeof import("node:child_process").spawn
    await detectAcpSupport("clineX", counting)
    await detectAcpSupport("clineX", counting)
    expect(calls).toBe(1)
  })

  it("returns false when spawn throws", async () => {
    const throwing = (() => { throw new Error("ENOENT") }) as unknown as typeof import("node:child_process").spawn
    expect(await detectAcpSupport("missing", throwing)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run cline-capabilities`
Expected: FAIL — cannot find module `../src/cline-capabilities.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cline-capabilities.ts`:

```ts
// Runtime detection of cline CLI capabilities.
//
// cline-sr's flag surface changed across versions (0.5.1 ships `--acp`, 0.6.0
// removed it). We probe `<command> --help` once per command and cache the
// result so the provider can auto-select the ACP vs subprocess transport
// without the user hand-editing `mode`.

import { spawn as nodeSpawn } from "node:child_process"

type SpawnFn = typeof nodeSpawn

const acpSupportCache = new Map<string, Promise<boolean>>()

/** True iff `<command> --help` advertises a `--acp` flag. Cached per command. */
export function detectAcpSupport(command: string, spawnFn: SpawnFn = nodeSpawn): Promise<boolean> {
  let cached = acpSupportCache.get(command)
  if (cached === undefined) {
    cached = probeAcpSupport(command, spawnFn)
    acpSupportCache.set(command, cached)
  }
  return cached
}

/** Reset the probe cache (tests / cline upgrade). */
export function clearAcpSupportCache(): void {
  acpSupportCache.clear()
}

function probeAcpSupport(command: string, spawnFn: SpawnFn): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(command, ["--help"], { stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      done(false)
      return
    }
    let out = ""
    const onData = (c: unknown) => {
      out += String(c)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      done(false)
    }, 5000)
    timer.unref?.()
    child.on("error", () => {
      clearTimeout(timer)
      done(false)
    })
    child.on("close", () => {
      clearTimeout(timer)
      done(/(^|\s)--acp(\s|$)/.test(out))
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run cline-capabilities`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cline-capabilities.ts test/cline-capabilities.test.ts
git commit -m "feat(provider): add detectAcpSupport --acp capability probe"
```

---

### Task 3: Add `reasoning-delta` StreamEvent + `"auto"` ClineMode

**Files:**
- Modify: `src/cline-runner.ts` (`StreamEvent` union, ~line 125)
- Modify: `src/types.ts` (`ClineMode`, ~line 23)

**Interfaces:**
- Produces: `StreamEvent` gains `{ type: "reasoning-delta"; delta: string }`. `ClineMode` gains `"auto"`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/reasoning-mode-types.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { StreamEvent } from "../src/cline-runner.js"
import type { ClineMode } from "../src/types.js"

describe("type surface", () => {
  it("StreamEvent accepts reasoning-delta", () => {
    const ev: StreamEvent = { type: "reasoning-delta", delta: "thinking" }
    expect(ev.type).toBe("reasoning-delta")
  })
  it("ClineMode accepts auto", () => {
    const m: ClineMode = "auto"
    expect(m).toBe("auto")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run reasoning-mode-types`
Expected: FAIL at typecheck — `"reasoning-delta"` / `"auto"` not assignable. (Vitest compiles per-file; the test errors.)

- [ ] **Step 3: Write minimal implementation**

In `src/cline-runner.ts`, extend the `StreamEvent` union — add the variant after `text-delta`:

```ts
export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
