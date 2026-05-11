export interface ClineHandoffInput {
  prompt: ReadonlyArray<unknown>
}

export interface ClineHandoffDiagnostics {
  originalBytes: number
  handoffBytes: number
  policyId: string | null
  messageBreakdown: Array<{
    index: number
    role: string
    contentBytes: number
    handoffSection: string
  }>
}

export interface ClineHandoffResult {
  text: string
  diagnostics: ClineHandoffDiagnostics
}

interface NormalizedMessage {
  index: number
  role: string
  content: unknown
  text: string
  contentBytes: number
}

interface ParsedText {
  text: string
  commandInstructions: string[]
  policyId: string | null
}

interface ToolSummaryBudget {
  textHeadBytes: number
  textTailBytes: number
  errorHeadBytes: number
  errorTailBytes: number
  metadataBytes: number
}

interface HandoffPolicyProfile {
  contextHeadBytes: number
  contextTailBytes: number
  toolBudget: ToolSummaryBudget
}

const DEFAULT_TOOL_SUMMARY_BUDGET: ToolSummaryBudget = {
  textHeadBytes: 2048,
  textTailBytes: 2048,
  errorHeadBytes: 4096,
  errorTailBytes: 4096,
  metadataBytes: 4096,
}

const DEFAULT_POLICY_PROFILE: HandoffPolicyProfile = {
  contextHeadBytes: 8192,
  contextTailBytes: 4096,
  toolBudget: DEFAULT_TOOL_SUMMARY_BUDGET,
}

const POLICY_PROFILES: Record<string, HandoffPolicyProfile> = {
  "diff-review": {
    contextHeadBytes: 4096,
    contextTailBytes: 4096,
    toolBudget: {
      textHeadBytes: 2048,
      textTailBytes: 2048,
      errorHeadBytes: 4096,
      errorTailBytes: 4096,
      metadataBytes: 2048,
    },
  },
  "debug-diagnose": {
    contextHeadBytes: 8192,
    contextTailBytes: 4096,
    toolBudget: {
      textHeadBytes: 3072,
      textTailBytes: 3072,
      errorHeadBytes: 8192,
      errorTailBytes: 8192,
      metadataBytes: 4096,
    },
  },
  "test-writing": {
    contextHeadBytes: 8192,
    contextTailBytes: 4096,
    toolBudget: {
      textHeadBytes: 4096,
      textTailBytes: 4096,
      errorHeadBytes: 6144,
      errorTailBytes: 6144,
      metadataBytes: 4096,
    },
  },
  "release-git": {
    contextHeadBytes: 4096,
    contextTailBytes: 2048,
    toolBudget: {
      textHeadBytes: 1536,
      textTailBytes: 1536,
      errorHeadBytes: 4096,
      errorTailBytes: 2048,
      metadataBytes: 2048,
    },
  },
  "doc-explain": {
    contextHeadBytes: 12288,
    contextTailBytes: 4096,
    toolBudget: {
      textHeadBytes: 4096,
      textTailBytes: 4096,
      errorHeadBytes: 4096,
      errorTailBytes: 4096,
      metadataBytes: 4096,
    },
  },
}

export function composeClineHandoff(input: ClineHandoffInput): ClineHandoffResult {
  const messages = normalizeMessages(input.prompt)
  const commandInstructions: string[] = []
  let policyId: string | null = null

  const parsedMessages = messages.map((message) => {
    const parsed = parseStructuredBlocks(message.text)
    commandInstructions.push(...parsed.commandInstructions)
    if (policyId === null && parsed.policyId !== null) policyId = parsed.policyId
    return { message, parsed }
  })

  const policyProfile = profileForPolicy(policyId)
  const cleaned = parsedMessages
    .map(({ message, parsed }) => {
      const text =
        message.role === "tool"
          ? stringifyContent(message.content, { summarizeToolResults: true, toolBudget: policyProfile.toolBudget })
          : parsed.text
      return { ...message, text: text.trim() }
    })
    .filter((message) => message.text.length > 0)

  const latestUserIndex = findLatestRoleIndex(cleaned, "user")
  const systemAndDeveloper = cleaned.filter((message) => message.role === "system" || message.role === "developer")
  const currentUser = latestUserIndex >= 0 ? cleaned[latestUserIndex] : null
  const latestUserOriginalIndex = currentUser?.index ?? -1
  const toolMessages = cleaned.filter((message) => message.role === "tool")
  const contextMessages = cleaned.filter((message, index) => {
    if (index === latestUserIndex) return false
    if (message.role === "system" || message.role === "developer" || message.role === "tool") return false
    return true
  })

  const sections: string[] = []
  pushSection(sections, "CURRENT_USER_REQUEST", currentUser?.text ?? "")
  pushSection(
    sections,
    "INSTRUCTIONS",
    [...systemAndDeveloper.map(formatMessageForContext), ...commandInstructions].join("\n\n"),
  )
  pushSection(
    sections,
    "RELEVANT_CONTEXT",
    contextMessages.map((message) => formatContextMessage(message, policyProfile)).join("\n\n"),
  )
  pushSection(sections, "TOOL_OBSERVATIONS", toolMessages.map(formatMessageForContext).join("\n\n"))
  if (policyId !== null) pushSection(sections, "CONTEXT_POLICY", `id: ${policyId}`)

  const text = sections.join("\n\n")
  const diagnostics: ClineHandoffDiagnostics = {
    originalBytes: messages.reduce((total, message) => total + message.contentBytes, 0),
    handoffBytes: Buffer.byteLength(text, "utf8"),
    policyId,
    messageBreakdown: messages.map((message) => ({
      index: message.index,
      role: message.role,
      contentBytes: message.contentBytes,
      handoffSection: classifyMessageSection(message, latestUserOriginalIndex),
    })),
  }

  return { text, diagnostics }
}

function normalizeMessages(prompt: ReadonlyArray<unknown>): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  for (let index = 0; index < prompt.length; index++) {
    const msg = prompt[index]
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) continue
    const m = msg as { role?: unknown; content?: unknown }
    const role = typeof m.role === "string" ? m.role : "user"
    const text = stringifyContent(m.content).trim()
    if (text.length === 0) continue
    messages.push({
      index,
      role,
      content: m.content,
      text,
      contentBytes: estimateContentBytes(m.content),
    })
  }
  return messages
}

function parseStructuredBlocks(text: string): ParsedText {
  const commandInstructions: string[] = []
  let policyId: string | null = null
  let cleaned = text.replace(/<command-instruction>([\s\S]*?)<\/command-instruction>/gi, (_match, body: string) => {
    const instruction = String(body).trim()
    if (instruction.length > 0) commandInstructions.push(instruction)
    return ""
  })

  cleaned = cleaned.replace(
    /<handoff-context-policy\b([^>]*)>[\s\S]*?<\/handoff-context-policy>/gi,
    (_match, attrs: string) => {
      if (policyId === null) policyId = pickIdAttribute(String(attrs))
      return ""
    },
  )

  return { text: cleaned, commandInstructions, policyId }
}

function pickIdAttribute(attrs: string): string | null {
  const match = attrs.match(/\bid=["']([^"']+)["']/i)
  return match?.[1] ?? null
}

function findLatestRoleIndex(messages: readonly NormalizedMessage[], role: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) return index
  }
  return -1
}

function pushSection(sections: string[], name: string, body: string): void {
  const trimmed = body.trim()
  if (trimmed.length === 0) return
  sections.push(`[${name}]\n${trimmed}\n[/${name}]`)
}

function formatMessageForContext(message: NormalizedMessage): string {
  return `<${message.role} index="${message.index}">\n${message.text}\n</${message.role}>`
}

function classifyMessageSection(message: NormalizedMessage, latestUserOriginalIndex: number): string {
  if (message.index === latestUserOriginalIndex) return "current_user_request"
  if (message.role === "system" || message.role === "developer") return "instructions"
  if (message.role === "tool") return "tool_observations"
  return "relevant_context"
}

function profileForPolicy(policyId: string | null): HandoffPolicyProfile {
  if (policyId === null) return DEFAULT_POLICY_PROFILE
  return POLICY_PROFILES[policyId] ?? DEFAULT_POLICY_PROFILE
}

function formatContextMessage(message: NormalizedMessage, policy: HandoffPolicyProfile): string {
  return summarizeText(
    formatMessageForContext(message),
    policy.contextHeadBytes,
    policy.contextTailBytes,
    `${message.role} context`,
  )
}

function stringifyContent(
  content: unknown,
  options: { summarizeToolResults?: boolean; toolBudget?: ToolSummaryBudget } = {},
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return ""
    return safeJson(content)
  }

  const out: string[] = []
  for (const part of content) {
    if (typeof part === "string") {
      out.push(part)
      continue
    }
    if (part === null || typeof part !== "object") continue
    const p = part as { type?: unknown; text?: unknown; output?: unknown; toolName?: unknown; image?: unknown }
    const type = typeof p.type === "string" ? p.type : ""
    switch (type) {
      case "text":
        if (typeof p.text === "string") out.push(p.text)
        break
      case "tool-call":
        out.push(`<tool-call name="${String(p.toolName ?? "")}">${safeJson((p as { args?: unknown }).args)}</tool-call>`)
        break
      case "tool-result":
        if (options.summarizeToolResults) {
          out.push(formatToolResultSummary(String(p.toolName ?? ""), p.output, options.toolBudget ?? DEFAULT_TOOL_SUMMARY_BUDGET))
        } else {
          out.push(`<tool-result name="${String(p.toolName ?? "")}">${safeJson(p.output)}</tool-result>`)
        }
        break
      case "image":
        out.push("<image omitted: cline subprocess mode does not support binary inputs>")
        break
      case "file":
        out.push("<file omitted>")
        break
      default:
        if (typeof p.text === "string") out.push(p.text)
    }
  }
  return out.join("\n")
}

function formatToolResultSummary(toolName: string, output: unknown, budget: ToolSummaryBudget): string {
  const lines = [`<tool-result name="${toolName}">`]
  if (output === null || output === undefined) {
    lines.push("(no output)")
    lines.push("</tool-result>")
    return lines.join("\n")
  }

  if (typeof output !== "object" || Array.isArray(output)) {
    lines.push(summarizeText(String(output), budget.textHeadBytes, budget.textTailBytes, "output"))
    lines.push("</tool-result>")
    return lines.join("\n")
  }

  const record = output as Record<string, unknown>
  const handled = new Set<string>()
  appendScalar(lines, record, handled, "command")
  appendScalar(lines, record, handled, "cmd")
  appendScalar(lines, record, handled, "path")
  appendScalar(lines, record, handled, "file")
  appendScalar(lines, record, handled, "exitCode")
  appendScalar(lines, record, handled, "status")
  appendScalar(lines, record, handled, "code")
  appendScalar(lines, record, handled, "signal")

  const stderr = pickTextField(record, handled, ["stderr", "error", "errorMessage"])
  if (stderr !== null) {
    lines.push("")
    lines.push("stderr:")
    lines.push(summarizeText(stderr, budget.errorHeadBytes, budget.errorTailBytes, "stderr"))
  }

  const stdout = pickTextField(record, handled, ["stdout", "output", "content", "result"])
  if (stdout !== null) {
    lines.push("")
    lines.push("stdout:")
    lines.push(summarizeText(stdout, budget.textHeadBytes, budget.textTailBytes, "stdout"))
  }

  const metadata = omitKeys(record, handled)
  if (Object.keys(metadata).length > 0) {
    lines.push("")
    lines.push("metadata:")
    lines.push(summarizeText(safeJson(metadata), budget.metadataBytes, 0, "metadata"))
  }

  lines.push("</tool-result>")
  return lines.join("\n")
}

function appendScalar(lines: string[], record: Record<string, unknown>, handled: Set<string>, key: string): void {
  if (!(key in record)) return
  const value = record[key]
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return
  handled.add(key)
  lines.push(`${key}: ${String(value)}`)
}

function pickTextField(record: Record<string, unknown>, handled: Set<string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!(key in record)) continue
    const value = record[key]
    if (value === null || value === undefined) continue
    handled.add(key)
    if (typeof value === "string") return value
    return safeJson(value)
  }
  return null
}

function omitKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) out[key] = value
  }
  return out
}

function summarizeText(text: string, headBytes: number, tailBytes: number, label: string): string {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= headBytes + tailBytes) return text
  const head = takeStartByBytes(text, headBytes)
  const tail = tailBytes > 0 ? takeEndByBytes(text, tailBytes) : ""
  const omittedBytes = Math.max(0, bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"))
  const marker = `[${label} omitted ${omittedBytes} bytes from the middle]`
  return tail.length > 0 ? `${head}\n${marker}\n${tail}` : `${head}\n${marker}`
}

function takeStartByBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ""
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8")
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    out += char
  }
  return out
}

function takeEndByBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ""
  const chars = Array.from(text)
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] ?? ""
    const charBytes = Buffer.byteLength(char, "utf8")
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    out = char + out
  }
  return out
}

function estimateContentBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8")
  if (content === null || content === undefined) return 0
  try {
    return Buffer.byteLength(JSON.stringify(content), "utf8")
  } catch {
    return Buffer.byteLength(String(content), "utf8")
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
