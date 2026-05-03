// Flatten an AI SDK v3 message array into a single text prompt string for cline.
//
// cline takes a single positional `--act "<prompt>"` arg, so we have to serialize
// the structured conversation into something readable. We follow this convention:
//
//   System messages → prepended with `[SYSTEM]\n...\n\n`
//   User / assistant messages → role marker like `[USER]\n...\n[/USER]\n` etc.
//   Tool messages → wrapped in their own `[TOOL_RESULT]\n...\n[/TOOL_RESULT]` block
//                   (kept separate from the assistant turn so cline can identify
//                    the result as external context rather than model output).
//
// We accept a relaxed `LanguageModelV3Prompt` shape — we don't import the full
// AI SDK types here to keep the dep surface small. The shape we expect:
//
//   type Msg =
//     | { role: "system"; content: string }
//     | { role: "user"; content: string | Array<{ type: "text"; text: string } | ...> }
//     | { role: "assistant"; content: string | Array<{ type: "text"; text: string } | ...> }
//     | { role: "tool"; content: Array<{ type: "tool-result"; toolName: string; output: unknown }> }
//
// Anything we don't recognize is best-effort stringified.

export interface FlattenInput {
  prompt: ReadonlyArray<unknown>
}

export function flattenPrompt(input: FlattenInput): string {
  const parts: string[] = []
  for (const msg of input.prompt) {
    if (msg === null || typeof msg !== "object") continue
    const m = msg as { role?: unknown; content?: unknown }
    const role = typeof m.role === "string" ? m.role : "user"
    const content = stringifyContent(m.content)
    if (content.length === 0) continue

    switch (role) {
      case "system":
        parts.push(`[SYSTEM]\n${content}\n`)
        break
      case "user":
        parts.push(`[USER]\n${content}\n[/USER]`)
        break
      case "assistant":
        parts.push(`[ASSISTANT]\n${content}\n[/ASSISTANT]`)
        break
      case "tool":
        parts.push(`[TOOL_RESULT]\n${content}\n[/TOOL_RESULT]`)
        break
      default:
        parts.push(`[${role.toUpperCase()}]\n${content}\n[/${role.toUpperCase()}]`)
    }
  }
  return parts.join("\n\n")
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return ""
    return safeJson(content)
  }
  // content is an array of "parts"
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
        // cline's text prompt can't embed images. Note their presence so the
        // caller knows information was dropped.
        out.push("<image (omitted — cline subprocess mode does not support binary inputs)>")
        break
      case "file":
        out.push(`<file (omitted)>`)
        break
      default:
        // Unknown part type — best-effort stringify text-ish fields.
        if (typeof p.text === "string") out.push(p.text)
    }
  }
  return out.join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
