// Streaming parser for `<opencode-call>` tags emitted by cline.
//
// cline's natural text output is intercepted between the runner and the V3
// LanguageModel stream. Whenever the running text contains:
//
//   <opencode-call name="<tool>">{...json args...}</opencode-call>
//
// we extract a structured tool-call, strip the tag from the text stream, and
// surface it as an opencode V3 `tool-call` part. Anything that doesn't match
// the protocol is forwarded as plain text.
//
// The parser is incremental: text arrives in arbitrary chunks (cline emits
// per-token deltas), so we buffer just enough trailing bytes to detect a
// tag that straddles a chunk boundary. Worst-case buffered prefix is the
// length of the open marker — 14 chars — when no `<` is in the buffer.
// When an open tag has been observed but the close marker has not, we
// hold the entire fragment until close arrives or the stream ends; on
// end-of-stream the unmatched fragment is surfaced as text (defensive
// fallback so partial output never silently disappears).

export interface OpencodeCall {
  toolName: string
  input: unknown
}

export interface ParseChunk {
  text: string
  calls: OpencodeCall[]
}

const OPEN_PREFIX = "<opencode-call"
const CLOSE_MARKER = "</opencode-call>"

export class OpencodeCallParser {
  private buffer = ""

  /** Feed a text chunk. Returns text safe to forward + any complete calls. */
  feed(chunk: string): ParseChunk {
    this.buffer += chunk
    const out: ParseChunk = { text: "", calls: [] }
    while (this.buffer.length > 0) {
      const openIdx = this.buffer.indexOf(OPEN_PREFIX)
      if (openIdx === -1) {
        // No open marker. Flush everything except a tail that COULD be the
        // start of an open marker — preserves partial-prefix detection across
        // the next feed().
        const keep = potentialPrefixLength(this.buffer, OPEN_PREFIX)
        const flushLen = this.buffer.length - keep
        if (flushLen > 0) out.text += this.buffer.slice(0, flushLen)
        this.buffer = this.buffer.slice(flushLen)
        break
      }
      // Surface text before the open marker.
      if (openIdx > 0) {
        out.text += this.buffer.slice(0, openIdx)
        this.buffer = this.buffer.slice(openIdx)
      }
      // Buffer now starts with OPEN_PREFIX. Look for end of opening element.
      const openTagEnd = this.buffer.indexOf(">", OPEN_PREFIX.length)
      if (openTagEnd === -1) break // need more
      // Look for the matching close marker.
      const closeIdx = this.buffer.indexOf(CLOSE_MARKER, openTagEnd + 1)
      if (closeIdx === -1) break // need more
      const opening = this.buffer.slice(0, openTagEnd + 1)
      const body = this.buffer.slice(openTagEnd + 1, closeIdx)
      const consumed = closeIdx + CLOSE_MARKER.length
      const parsed = parseCall(opening, body)
      this.buffer = this.buffer.slice(consumed)
      // Eat a single trailing newline so the tag occupies its own line cleanly.
      if (this.buffer.startsWith("\r\n")) this.buffer = this.buffer.slice(2)
      else if (this.buffer.startsWith("\n")) this.buffer = this.buffer.slice(1)
      if (parsed) {
        out.calls.push(parsed)
      } else {
        // Malformed tag — surface the raw text so nothing is silently dropped.
        out.text += opening + body + CLOSE_MARKER
      }
    }
    return out
  }

  /** Flush any held buffer as text (called at end of stream). */
  flush(): ParseChunk {
    const remainder = this.buffer
    this.buffer = ""
    return remainder.length === 0 ? { text: "", calls: [] } : { text: remainder, calls: [] }
  }
}

function parseCall(opening: string, body: string): OpencodeCall | null {
  const nameMatch = opening.match(/\bname=("([^"]*)"|'([^']*)')/)
  if (!nameMatch) return null
  const toolName = nameMatch[2] ?? nameMatch[3] ?? ""
  if (toolName.length === 0) return null
  const trimmed = body.trim()
  try {
    const input = trimmed.length === 0 ? {} : JSON.parse(trimmed)
    return { toolName, input }
  } catch {
    return null
  }
}

/**
 * Returns the length of the trailing suffix of `buf` that could be a prefix
 * of `target`. Used to keep just enough of the buffer to detect a tag that
 * straddles a chunk boundary, without growing the buffer unboundedly.
 */
function potentialPrefixLength(buf: string, target: string): number {
  const max = Math.min(buf.length, target.length - 1)
  for (let n = max; n >= 1; n--) {
    if (target.startsWith(buf.slice(buf.length - n))) return n
  }
  return 0
}

// ─── Protocol section appended to the cline handoff ──────────────────────────

export interface ProtocolToolDescriptor {
  /** Tool name registered with opencode (must match LanguageModelV3FunctionTool.name). */
  name: string
}

/**
 * Build the OPENCODE_CALL_PROTOCOL section appended to the cline handoff,
 * teaching cline how to emit `<opencode-call>` tags. We list only the
 * supported tool *names* — the rest (available skills, agent roster) is
 * already present in the system prompt opencode sends, so re-listing here
 * would double-count tokens.
 *
 * Returns null when no recognized tool is registered — callers must skip
 * the section entirely in that case (no point teaching the protocol if
 * no tool would survive the whitelist check on the parser side).
 */
export function buildProtocolSection(tools: readonly ProtocolToolDescriptor[]): string | null {
  const names = new Set<string>()
  for (const t of tools) {
    if (SUPPORTED_OPENCODE_CALL_TOOLS.has(t.name)) names.add(t.name)
  }
  if (names.size === 0) return null

  const lines: string[] = []
  lines.push("[OPENCODE_CALL_PROTOCOL]")
  lines.push(
    "To delegate to a registered opencode tool, emit ONE tag on its own line, BEFORE prose:",
  )
  // Tool input shapes come from opencode's actual tool schemas:
  //   task          → { description, prompt, subagent_type }   (all required)
  //   skill         → { name }                                  (required)
  //   lane_dispatch → { agent, prompt, label? }   (omac-scheduler plugin)
  //   lane_collect  → { laneIds?, timeoutSeconds? } (omac-scheduler plugin)
  // Names are LOWERCASE — opencode registers tools as lowercase identifiers
  // (verified against opencode-ai 1.14.x). Mismatched case would silently
  // drop the dispatch.
  if (names.has("task")) {
    lines.push(
      '  <opencode-call name="task">{"subagent_type":"<agent>","description":"<3-5 words>","prompt":"<text>"}</opencode-call>',
    )
  }
  if (names.has("skill")) {
    lines.push(
      '  <opencode-call name="skill">{"name":"<skill-name-from-available_skills>"}</opencode-call>',
    )
  }
  // omac-scheduler background lanes: emit one lane_dispatch per INDEPENDENT
  // subtask (they run concurrently), then a single lane_collect to gather.
  if (names.has("lane_dispatch")) {
    lines.push(
      '  <opencode-call name="lane_dispatch">{"agent":"<agent>","prompt":"<text>","label":"<short label>"}</opencode-call>',
    )
  }
  if (names.has("lane_collect")) {
    lines.push(
      '  <opencode-call name="lane_collect">{"laneIds":["<laneId>"],"timeoutSeconds":300}</opencode-call>',
    )
  }
  lines.push(
    "Pick names from the system context (available_skills / agent roster). The tag is",
  )
  lines.push("consumed by the host — continue the answer AFTER it. Skip if no tool applies.")
  lines.push("[/OPENCODE_CALL_PROTOCOL]")
  return lines.join("\n")
}

/**
 * Allow-list used by the runtime parser. Lowercase to match opencode's
 * actual tool registry (verified against opencode-ai 1.14.x binary; see
 * the comment in buildProtocolSection above).
 */
export const SUPPORTED_OPENCODE_CALL_TOOLS: ReadonlySet<string> = new Set([
  "task",
  "skill",
  // omac-scheduler plugin tools (true background parallel lanes).
  "lane_dispatch",
  "lane_collect",
])

/**
 * Detect a slash-command-style skill dispatch in opencode's command
 * instructions and return the skill name to load.
 *
 * Background: when a user types `/karpathy ...`, opencode's TUI rewrites
 * the prompt with a `<command-instruction>` block. The block carries text
 * like:
 *
 *   Run the `karpathy-guidelines` skill workflow on the user's request.
 *
 * cline's autonomous models reliably IGNORE this instruction (they just
 * read whatever file the user mentioned and answer with their own tools).
 * To make slash commands actually load the skill content, the provider
 * intercepts the prompt BEFORE handing it to cline: when we see a skill
 * workflow directive AND the `skill` tool is registered, we short-circuit
 * cline and emit a host-side `skill` tool-call ourselves. opencode runs
 * the skill, injects SKILL.md content, and the conversation continues on
 * the next turn — now with cline seeing the real skill rules in context.
 *
 * Returns null when no skill workflow directive is present.
 */
export function detectSkillSlashCommand(
  commandInstructions: readonly string[],
): string | null {
  // Pattern: `Run the` (case-insensitive), a backtick-quoted skill id,
  // then `skill workflow`. The id grammar accepts plugin-prefixed ids
  // (`github:gh-address-comments`, `caveman:caveman-review`, …) — opencode
  // skill ids may carry a `<plugin>:` prefix when shipped via plugins.
  // Disallowed: whitespace, shell metacharacters, anything that isn't
  // already a normal identifier byte. Tight enough to avoid false
  // positives in normal prose; permissive enough for plugin namespacing.
  const re = /Run\s+the\s+`([a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?)`\s+skill\s+workflow/i
  for (const instruction of commandInstructions) {
    const m = instruction.match(re)
    if (m && typeof m[1] === "string" && m[1].length > 0) return m[1]
  }
  return null
}

/**
 * Extract every `<skill><name>X</name>...</skill>` id from a handoff blob.
 * opencode injects an `<available_skills>` catalog into the agent's system
 * message — that's our authoritative list of what's actually loadable in
 * this turn. We use it as the closed-world dictionary for the natural-
 * language detector below, so an arbitrary word that happens to match a
 * trigger pattern (e.g. "use the file") doesn't fire a phantom skill
 * dispatch.
 */
export function extractAvailableSkillNames(handoffText: string): string[] {
  const seen = new Set<string>()
  const re = /<skill>\s*<name>([a-z][a-z0-9_:\-]*)<\/name>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(handoffText)) !== null) {
    if (m[1]) seen.add(m[1])
  }
  return [...seen]
}

/**
 * Detect a natural-language skill invocation in the latest user request.
 *
 * Background: the slash-command bypass (`detectSkillSlashCommand`) works
 * when opencode TUI rewrites `/karpathy` into a structured
 * `<command-instruction>` block. But the user can also type prose like
 * "karpathy 스킬로 install.sh 분석해줘" or "use the dead-code-finder
 * skill" — opencode does NOT rewrite those, so they reach cline as-is
 * and custom cline builds reliably ignore the directive. This detector
 * brings the prose path up to the same level: when the user prompt
 * carries a skill name AND a trigger verb (use/apply/run/적용/사용/로
 * 분석/...), provider dispatches the matching `skill` tool-call
 * directly — same bypass mechanism as the slash path, just a different
 * source.
 *
 * Closed-world: only names present in `availableSkills` can match, so
 * the user can't trigger an unregistered skill by saying its name.
 *
 * Match policy:
 *   - longest-id-first (so `code-review` beats `code` when both are in
 *     the catalog and both appear in the prompt)
 *   - case-insensitive
 *   - requires an adjacent trigger token (verb / particle / `skill`
 *     keyword) so a bare mention like "what does X do?" does NOT fire
 *
 * Returns the matched skill name or null.
 */
export function detectSkillNaturalLanguage(
  userText: string,
  availableSkills: readonly string[],
): string | null {
  if (availableSkills.length === 0 || userText.length === 0) return null
  const sorted = [...availableSkills].sort((a, b) => b.length - a.length)
  for (const skill of sorted) {
    if (!skill) continue
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const patterns: RegExp[] = [
      // EN: trigger verb + (the)? <skill> [skill]
      //   e.g. "use karpathy", "apply the code-review skill"
      new RegExp(
        `\\b(?:use|using|via|apply|run|trigger|invoke|exec(?:ute)?|launch|fire)\\s+(?:the\\s+)?${escaped}(?:\\s+skill)?\\b`,
        "i",
      ),
      // EN: "<skill> skill" requires an imperative tail (to/for/on/now/…)
      // so a benign mention like "the X skill" alone does NOT fire.
      new RegExp(`\\b${escaped}\\s+skill\\s+(?:to|for|on|please|now|here)\\b`, "i"),
      // KO: <skill> 스킬 (Hangul 스킬 keyword only — the English `skill`
      // word is covered by the verb-anchored EN patterns above, so a
      // bare "X skill" without a verb stays a non-trigger).
      new RegExp(
        `${escaped}\\s*스킬(?:\\s*(?:로|을|를|이|가|에서|으로))?`,
        "i",
      ),
      // KO: <skill>로|으로 + 동사 (분석|리뷰|검토|체크|확인|점검|진단|적용|호출|동작|사용|실행|돌려|돌리)
      new RegExp(
        `${escaped}\\s*(?:로|으로)\\s*(?:분석|리뷰|검토|체크|확인|점검|진단|적용|호출|동작|사용|실행|돌려|돌리)`,
        "i",
      ),
      // KO: <skill>(을|를) + 적용|사용|호출|실행|돌려|돌리
      new RegExp(
        `${escaped}\\s*(?:을|를)\\s*(?:적용|사용|호출|실행|돌려|돌리)`,
        "i",
      ),
    ]
    for (const p of patterns) {
      if (p.test(userText)) return skill
    }
  }
  return null
}

/**
 * Has this exact skill name already been dispatched earlier in the
 * conversation? Loop guard for the bypass paths.
 *
 * Background (codex P1): after `maybeResolveSkillBypass` emits a `skill`
 * tool-call and opencode runs the skill, the conversation re-enters us
 * with the ORIGINAL user message (`<command-instruction>` and all)
 * PLUS a new tool-result. If we re-detect the same directive without
 * checking history, we emit the same skill tool-call again — opencode
 * dispatches again — turn loops. The bypass must skip when the same
 * skill has already been dispatched in this conversation.
 *
 * Detection is byte-level on the handoff: `stringifyContent` renders
 * historical assistant tool-calls as
 *   `<tool-call name="skill">{"name":"<id>"}</tool-call>`
 * (see cline-handoff.ts), so the prior dispatch is searchable as a
 * literal substring without depending on the prompt's structured shape.
 */
export function isSkillAlreadyDispatchedInHandoff(
  handoffText: string,
  skillName: string,
): boolean {
  if (skillName.length === 0) return false
  // Match `<tool-call name="skill">` followed (within reasonable bytes)
  // by `"name":"<skillName>"`. We cap the inter-token distance so we
  // don't cross into a later, unrelated tool-call.
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(
    `<tool-call name="skill">[^<]{0,400}"name":"${escaped}"`,
  )
  return re.test(handoffText)
}

/**
 * Convenience: run the natural-language detector against a full handoff
 * blob. Extracts both the latest user request and the `<available_skills>`
 * catalog, then delegates to `detectSkillNaturalLanguage`. Returns null
 * when either piece is missing.
 */
export function detectSkillNaturalLanguageInHandoff(handoffText: string): string | null {
  const userMatch = handoffText.match(
    /\[CURRENT_USER_REQUEST\]\n([\s\S]*?)\n\[\/CURRENT_USER_REQUEST\]/,
  )
  if (!userMatch || !userMatch[1]) return null
  const skills = extractAvailableSkillNames(handoffText)
  return detectSkillNaturalLanguage(userMatch[1], skills)
}
