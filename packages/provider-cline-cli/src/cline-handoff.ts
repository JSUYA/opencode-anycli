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
  text: string
  contentBytes: number
}

interface ParsedText {
  text: string
  commandInstructions: string[]
  policyId: string | null
}

export function composeClineHandoff(input: ClineHandoffInput): ClineHandoffResult {
  const messages = normalizeMessages(input.prompt)
  const commandInstructions: string[] = []
  let policyId: string | null = null

  const cleaned = messages
    .map((message) => {
      const parsed = parseStructuredBlocks(message.text)
      commandInstructions.push(...parsed.commandInstructions)
      if (policyId === null && parsed.policyId !== null) policyId = parsed.policyId
      return { ...message, text: parsed.text.trim() }
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
  pushSection(sections, "RELEVANT_CONTEXT", contextMessages.map(formatMessageForContext).join("\n\n"))
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

function stringifyContent(content: unknown): string {
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
        out.push(`<tool-result name="${String(p.toolName ?? "")}">${safeJson(p.output)}</tool-result>`)
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
