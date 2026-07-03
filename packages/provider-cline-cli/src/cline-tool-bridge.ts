// Bridge: cline-native tool events → opencode V3 tool-call/result parts.
//
// cline runs an autonomous agent loop with its OWN tool inventory (readFile,
// execute_command, search_files, etc.). When opencode is the host, those
// tool invocations are otherwise invisible — the user sees only the final
// text. This module translates cline's NDJSON tool events into opencode's
// V3 stream protocol so the host UI can render them as first-class tool
// calls, AND so subsequent host-side processing (LSP touchFile, permission
// checks, session metadata) actually fires.
//
// Design tenets:
//
//   1. Forward-compatible: cline's tool names have churned across releases
//      (camelCase ↔ snake_case, renames, additions). Every mapping entry
//      lists every alias we've ever observed; unknown tools fall through
//      as a generic `cline:<name>` tool-call so opencode still shows the
//      activity without us having to ship a new release for every cline
//      rename.
//
//   2. Provider-executed: cline already ran the tool. We emit the call so
//      the UI knows about it, then we emit the result with the captured
//      output. The host MUST NOT re-execute — see CLINE_PROVIDER_EXECUTED
//      flag handling in the runner.
//
//   3. Schema-tolerant: cline payloads can be JSON (say.tool's text is a
//      JSON blob) or plain strings (say.command's text is the shell line).
//      Each transform accepts the raw shape and projects to a minimal
//      opencode input. Missing fields are absent rather than reverse-
//      engineered — we never invent paths or commands.
//
//   4. Backward-compatible: the legacy single-tool path
//      (`pickReadFileCall` + `CLINE_READ_TOOL_NAME = "read"` in
//      cline-runner.ts) remains the canonical readFile-only fast path so
//      existing consumers see no regression. The bridge here is additive.

/**
 * Lookup of all cline tool aliases we've observed across cline versions,
 * mapping to the matching opencode tool name. Aliases are compared after
 * lower-casing AND collapsing `_` / `-` so historic and current spellings
 * resolve identically.
 *
 * When you find a NEW cline tool name in a future release, add it here —
 * everything else (runner, language-model, tests) picks the new alias up
 * automatically through the resolver below.
 */
const CLINE_TO_OPENCODE_ALIASES: Record<string, string> = {
  // File reading
  readfile: "read",
  read_file: "read",
  read: "read",

  // File writing (new file or full overwrite)
  writetofile: "write",
  write_to_file: "write",
  write_file: "write",
  writefile: "write",
  write: "write",
  newfile: "write",
  new_file: "write",
  createfile: "write",
  create_file: "write",

  // File editing (in-place patch)
  replaceinfile: "edit",
  replace_in_file: "edit",
  applydiff: "edit",
  apply_diff: "edit",
  edit_file: "edit",
  editfile: "edit",
  edit: "edit",
  patch_file: "edit",

  // Shell
  executecommand: "bash",
  execute_command: "bash",
  exec_command: "bash",
  bash: "bash",
  shell: "bash",
  command: "bash",
  run_command: "bash",

  // Directory listing
  listfiles: "glob",
  list_files: "glob",
  ls: "glob",
  list_dir: "glob",
  list_directory: "glob",
  glob: "glob",

  // Code search
  searchfiles: "grep",
  search_files: "grep",
  search: "grep",
  grep: "grep",
  ripgrep: "grep",

  // Web
  webfetch: "webfetch",
  web_fetch: "webfetch",
  fetch_url: "webfetch",
  fetch: "webfetch",

  websearch: "websearch",
  web_search: "websearch",
}

/** Normalize a cline tool name for alias lookup. */
export function normalizeClineToolName(raw: string): string {
  return raw.toLowerCase().replace(/[_\-]/g, "")
}

/** Resolve a cline tool name to an opencode tool name, or null when unknown. */
export function resolveOpencodeTool(clineName: string): string | null {
  const key = normalizeClineToolName(clineName)
  return CLINE_TO_OPENCODE_ALIASES[key] ?? null
}

/** Source shape for a cline `say.tool` event after JSON-decoding its `text`. */
export interface ClineToolPayload {
  tool?: unknown
  // readFile / read_file
  path?: unknown
  content?: unknown
  readLineStart?: unknown
  readLineEnd?: unknown
  // write_to_file
  // (uses path + content)
  // replace_in_file / apply_diff
  diff?: unknown
  // search_files
  regex?: unknown
  filePattern?: unknown
  file_pattern?: unknown
  // list_files
  recursive?: unknown
  // browser/MCP/web — captured opaquely
  [key: string]: unknown
}

/** Result emitted to the V3 stream — both tool-call and tool-result halves. */
export interface BridgedToolEvent {
  /** opencode tool name (lowercase, matches LanguageModelV3FunctionTool.name). */
  toolName: string
  /** opencode-shaped input parameters. */
  input: Record<string, unknown>
  /**
   * Synthetic result payload to emit alongside the call. cline already ran
   * the tool, so we surface the OUTPUT here. The host MUST treat this
   * tool-call as provider-executed and skip re-running it.
   */
  result: Record<string, unknown>
  /**
   * When true, the cline-side execution finished successfully. When false
   * (e.g. command exit-code non-zero), the result is marked `isError`.
   */
  ok: boolean
  /**
   * Free-form passthrough name kept for telemetry — the originating cline
   * name BEFORE alias resolution. Lets opencode logs trace back to which
   * cline schema produced this entry.
   */
  originalClineName: string
}

/**
 * Bridge a cline `say.tool` payload (already JSON-parsed from say.tool.text)
 * to an opencode tool-call+result pair. Returns `null` when the payload
 * lacks a recognizable `tool` field.
 *
 * Unknown tools (no alias entry) fall through as `cline:<original>` so the
 * UI still surfaces the activity. Forward-compat lever for cline renames.
 */
export function bridgeClineToolEvent(payload: ClineToolPayload): BridgedToolEvent | null {
  const rawName = typeof payload.tool === "string" ? payload.tool : null
  if (rawName === null) return null

  const opencodeName = resolveOpencodeTool(rawName)
  const handler = opencodeName !== null ? TOOL_TRANSFORMS[opencodeName] : null

  if (handler) return handler(payload, rawName)

  // Unknown / unmapped tool — surface as cline:<name> so the activity isn't
  // silently dropped. Forward-compat fallback for cline tool additions.
  return {
    toolName: `cline:${rawName}`,
    input: pickPassthroughInput(payload),
    result: { ok: true },
    ok: true,
    originalClineName: rawName,
  }
}

/**
 * Bridge a cline `say.command` event (raw shell command text) to an
 * opencode `bash` tool-call. The output is supplied separately via
 * `attachCommandOutput` once the matching `ask.command_output` event
 * arrives — call sites pair them via emission order in cline-runner.
 */
export function bridgeClineCommandStart(commandText: string): BridgedToolEvent {
  return {
    toolName: "bash",
    input: { command: commandText },
    result: { ok: true },
    ok: true,
    originalClineName: "execute_command",
  }
}

/**
 * Build the tool-result payload for a previously emitted `bash` tool-call
 * once the corresponding command output arrives. Caller is responsible
 * for matching toolCallId — this function only formats the result body.
 */
export function buildCommandOutputResult(output: string, exitCode?: number): {
  result: Record<string, unknown>
  ok: boolean
} {
  const ok = exitCode === undefined ? true : exitCode === 0
  const result: Record<string, unknown> = {
    ok,
    stdout: output,
  }
  if (exitCode !== undefined) result["exitCode"] = exitCode
  return { result, ok }
}

// ─── cline 0.6.0 agent-event tool schema ─────────────────────────────────────
//
// cline 0.6.0 (Samsung cline-sr) no longer emits legacy `say.tool` /
// `say.command` events. Native tool activity now arrives as an `agent_event`
// pair:
//
//   content_start { contentType:"tool", toolCallId, toolName, input }
//   content_end   { contentType:"tool", toolCallId, toolName, output }
//
// The tool NAMES and INPUT shapes differ from the legacy schema and cline
// batches homogeneous operations into a single call:
//
//   read_files    input {files:[{path}]}            output [{query,result,success}]
//   run_commands  input {commands:[string]}         output [{query,result,success}]
//   editor        input {path,new_text[,old_text]}  output {query,result,success}
//
// `bridgeAgentEventTool` fans a single cline call out to one opencode
// tool-call/result pair per underlying operation. Unknown tools fall through
// as one `cline:<name>` entry so activity is never silently dropped.

/** A single bridged tool-call+result pair from the agent-event tool schema. */
export interface AgentToolBridge {
  /** opencode tool name (must match a registered LanguageModelV3FunctionTool). */
  toolName: string
  input: Record<string, unknown>
  result: Record<string, unknown>
  ok: boolean
  /** Suffix appended to cline's toolCallId to keep multi-item calls unique. */
  idSuffix: string
  /** cline tool name before alias resolution — kept for telemetry. */
  originalClineName: string
}

export function bridgeAgentEventTool(
  clineName: string,
  input: unknown,
  output: unknown,
): AgentToolBridge[] {
  const key = normalizeClineToolName(clineName)
  const inRec = isObject(input) ? input : {}
  switch (key) {
    case "readfiles":
    case "readfile":
    case "read":
      return bridgeReadFiles(inRec, output, clineName)
    case "runcommands":
    case "runcommand":
    case "executecommand":
    case "execcommand":
    case "bash":
    case "shell":
    case "command":
      return bridgeRunCommands(inRec, output, clineName)
    case "editor":
    case "editfile":
    case "edit":
    case "replaceinfile":
    case "applydiff":
    case "writetofile":
    case "writefile":
    case "write":
    case "createfile":
    case "newfile":
      return bridgeEditor(inRec, output, clineName)
    default: {
      // Unknown tool — surface as cline:<name> so opencode still shows the
      // activity. Forward-compat lever for cline tool additions/renames.
      const opencode = resolveOpencodeTool(clineName)
      const outcome = firstOutcome(output)
      return [
        {
          toolName: opencode ?? `cline:${clineName}`,
          input: flattenRecord(inRec),
          result: outcome.result,
          ok: outcome.ok,
          idSuffix: "",
          originalClineName: clineName,
        },
      ]
    }
  }
}

function bridgeReadFiles(input: Record<string, unknown>, output: unknown, original: string): AgentToolBridge[] {
  const files = Array.isArray(input["files"]) ? (input["files"] as unknown[]) : []
  const outputs = Array.isArray(output) ? output : []
  if (files.length === 0) {
    // Some builds put a bare `path` on the input instead of files[].
    const path = pickString(input["path"]) ?? pickString(input["filePath"])
    if (path === null) return []
    const outcome = outcomeAt(outputs, 0)
    return [readEntry(path, outcome, original, "-r0")]
  }
  const out: AgentToolBridge[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const path = isObject(f) ? pickString(f["path"]) ?? pickString(f["filePath"]) : pickString(f)
    if (path === null) continue
    out.push(readEntry(path, outcomeAt(outputs, i), original, `-r${i}`))
  }
  return out
}

function readEntry(path: string, outcome: Outcome, original: string, idSuffix: string): AgentToolBridge {
  const result: Record<string, unknown> = { ok: outcome.ok, filePath: path }
  if (outcome.text !== null) result["output"] = outcome.text
  return { toolName: "read", input: { filePath: path }, result, ok: outcome.ok, idSuffix, originalClineName: original }
}

function bridgeRunCommands(input: Record<string, unknown>, output: unknown, original: string): AgentToolBridge[] {
  const commands = Array.isArray(input["commands"])
    ? (input["commands"] as unknown[])
    : pickString(input["command"]) !== null
      ? [input["command"]]
      : []
  const outputs = Array.isArray(output) ? output : output !== undefined && output !== null ? [output] : []
  if (commands.length === 0) return []
  const out: AgentToolBridge[] = []
  for (let i = 0; i < commands.length; i++) {
    const command = pickString(commands[i])
    if (command === null) continue
    const outcome = outcomeAt(outputs, i)
    const result: Record<string, unknown> = { ok: outcome.ok }
    if (outcome.text !== null) result["stdout"] = outcome.text
    out.push({ toolName: "bash", input: { command }, result, ok: outcome.ok, idSuffix: `-c${i}`, originalClineName: original })
  }
  return out
}

function bridgeEditor(input: Record<string, unknown>, output: unknown, original: string): AgentToolBridge[] {
  const filePath = pickString(input["path"]) ?? pickString(input["filePath"])
  if (filePath === null) return []
  const newText = pickString(input["new_text"]) ?? pickString(input["content"]) ?? pickString(input["newText"])
  const oldText = pickString(input["old_text"]) ?? pickString(input["oldText"])
  const diff = pickString(input["diff"])
  const outcome = Array.isArray(output) ? normalizeOutcome(output[0]) : normalizeOutcome(output)
  // old_text / diff present → in-place edit; otherwise a create/overwrite write.
  if (oldText !== null || diff !== null) {
    const editInput: Record<string, unknown> = { filePath }
    if (oldText !== null) editInput["oldString"] = oldText
    if (newText !== null) editInput["newString"] = newText
    if (diff !== null) editInput["diff"] = diff
    const result: Record<string, unknown> = { ok: outcome.ok, filePath }
    if (outcome.text !== null) result["output"] = outcome.text
    return [{ toolName: "edit", input: editInput, result, ok: outcome.ok, idSuffix: "", originalClineName: original }]
  }
  const writeInput: Record<string, unknown> = { filePath }
  if (newText !== null) writeInput["content"] = newText
  const result: Record<string, unknown> = { ok: outcome.ok, filePath }
  if (outcome.text !== null) result["output"] = outcome.text
  return [{ toolName: "write", input: writeInput, result, ok: outcome.ok, idSuffix: "", originalClineName: original }]
}

/** Normalized view of one cline output element ({query,result,success}). */
interface Outcome {
  ok: boolean
  text: string | null
}

function outcomeAt(outputs: readonly unknown[], index: number): Outcome {
  return normalizeOutcome(outputs[index] ?? outputs[0])
}

function firstOutcome(output: unknown): { ok: boolean; result: Record<string, unknown> } {
  const outcome = Array.isArray(output) ? normalizeOutcome(output[0]) : normalizeOutcome(output)
  const result: Record<string, unknown> = { ok: outcome.ok }
  if (outcome.text !== null) result["output"] = outcome.text
  return { ok: outcome.ok, result }
}

function normalizeOutcome(raw: unknown): Outcome {
  if (!isObject(raw)) return { ok: true, text: null }
  const success = raw["success"]
  const ok = success === undefined ? true : success === true
  const text = pickString(raw["result"]) ?? pickString(raw["output"]) ?? pickString(raw["stdout"])
  return { ok, text }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Flatten a record to JSON-serializable primitives for unknown-tool passthrough. */
function flattenRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v
    } else {
      try {
        out[k] = JSON.parse(JSON.stringify(v))
      } catch {
        /* drop */
      }
    }
  }
  return out
}

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

// ─── Per-tool transforms ─────────────────────────────────────────────────────

type Transform = (raw: ClineToolPayload, originalName: string) => BridgedToolEvent

const TOOL_TRANSFORMS: Record<string, Transform> = {
  read: (raw, original) => {
    // cline emits both `path` (workspace-relative) and `content` (absolute
    // resolved). Prefer absolute so opencode's read tool resolves the
    // correct file without depending on the host's cwd.
    const filePath = pickString(raw.content) ?? pickString(raw.path)
    const start = pickNumber(raw.readLineStart)
    const end = pickNumber(raw.readLineEnd)
    const input: Record<string, unknown> = {}
    if (filePath !== null) input["filePath"] = filePath
    if (start !== null) input["offset"] = start
    if (start !== null && end !== null && end >= start) input["limit"] = end - start + 1
    return {
      toolName: "read",
      input,
      result: { ok: true, filePath: filePath ?? undefined },
      ok: true,
      originalClineName: original,
    }
  },
  write: (raw, original) => {
    // For write_to_file, `path` is the workspace-relative filename and
    // `content` is the file BODY. Unlike readFile (where cline overloads
    // `content` to carry the absolute path), write never puts the path
    // there — so we prefer `path` strictly and treat `content` as body.
    const filePath = pickString(raw.path)
    const content = pickString(raw["content"])
    const input: Record<string, unknown> = {}
    if (filePath !== null) input["filePath"] = filePath
    if (content !== null) input["content"] = content
    return {
      toolName: "write",
      input,
      result: { ok: true, filePath: filePath ?? undefined },
      ok: true,
      originalClineName: original,
    }
  },
  edit: (raw, original) => {
    // replace_in_file / apply_diff: `path` is the file, `diff` is the
    // patch. cline never overloads `content` here either.
    const filePath = pickString(raw.path)
    const diff = pickString(raw.diff)
    const input: Record<string, unknown> = {}
    if (filePath !== null) input["filePath"] = filePath
    if (diff !== null) input["diff"] = diff
    return {
      toolName: "edit",
      input,
      result: { ok: true, filePath: filePath ?? undefined },
      ok: true,
      originalClineName: original,
    }
  },
  bash: (raw, original) => {
    // Rare path — most cline `bash` activity arrives via `say.command`, not
    // `say.tool`. This branch handles the (occasional) tool-shaped emission.
    const command = pickString(raw["command"]) ?? pickString(raw.content) ?? ""
    return {
      toolName: "bash",
      input: { command },
      result: { ok: true },
      ok: true,
      originalClineName: original,
    }
  },
  glob: (raw, original) => {
    const path = pickString(raw.path) ?? "."
    const recursive = raw.recursive === true
    // For list_files, cline puts the LISTING body in `content`. Capture it
    // in the result so consumers can see what was listed; do NOT use it
    // as the pattern (that'd produce a glob like `<output>/**`).
    const output = pickString(raw.content)
    const result: Record<string, unknown> = { ok: true }
    if (output !== null) result["output"] = output
    return {
      toolName: "glob",
      input: { pattern: recursive ? `${path}/**` : `${path}/*` },
      result,
      ok: true,
      originalClineName: original,
    }
  },
  grep: (raw, original) => {
    const pattern = pickString(raw.regex) ?? ""
    const path = pickString(raw.path) ?? "."
    const filePattern =
      pickString(raw.filePattern) ?? pickString(raw.file_pattern) ?? undefined
    // cline overloads `content` per tool: for grep/search and list it
    // carries the OUTPUT body (matches / directory listing). Preserve it
    // in the result so opencode renderers and runOnce text consumers
    // both see the search hits.
    const output = pickString(raw.content)
    const input: Record<string, unknown> = { pattern, path }
    if (filePattern !== undefined) input["include"] = filePattern
    const result: Record<string, unknown> = { ok: true }
    if (output !== null) result["output"] = output
    return {
      toolName: "grep",
      input,
      result,
      ok: true,
      originalClineName: original,
    }
  },
  webfetch: (raw, original) => {
    const url = pickString(raw["url"]) ?? pickString(raw.content) ?? ""
    return {
      toolName: "webfetch",
      input: { url },
      result: { ok: true },
      ok: true,
      originalClineName: original,
    }
  },
  websearch: (raw, original) => {
    const query = pickString(raw["query"]) ?? pickString(raw.content) ?? ""
    return {
      toolName: "websearch",
      input: { query },
      result: { ok: true },
      ok: true,
      originalClineName: original,
    }
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * For unknown tools we can't shape — preserve a flat snapshot of the JSON-
 * serializable fields so opencode can render *something* useful. We strip
 * the `tool` key (it's metadata, not input) and skip nested non-primitives
 * beyond depth 1 to avoid exporting cycles.
 */
function pickPassthroughInput(payload: ClineToolPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k === "tool") continue
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[k] = v
    } else if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
      try {
        // shallow JSON-clone, ignore if not serializable
        out[k] = JSON.parse(JSON.stringify(v))
      } catch {
        /* drop */
      }
    }
  }
  return out
}

