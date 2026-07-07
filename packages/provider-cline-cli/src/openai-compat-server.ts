import { randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import {
  createToolCallSignature,
  emptyClineUsage,
  runClineTurn,
  runClineTurnOnce,
  type ClineTurnConfig,
  type ClineTurnEvent,
  type ClineTurnRequest,
} from "./cline-turn-engine.js"
import type { ProtocolToolDescriptor } from "./opencode-call-parser.js"
import type { ClineUsage } from "./types.js"

type JsonRecord = Record<string, unknown>

export interface OpenAiCompatModel {
  id: string
  name?: string | undefined
}

export interface OpenAiCompatServerOptions {
  models: readonly OpenAiCompatModel[]
  config?: ClineTurnConfig | undefined
  host?: string | undefined
  port?: number | undefined
  token?: string | undefined
  runTurn?: ((request: ClineTurnRequest) => AsyncIterable<ClineTurnEvent>) | undefined
}

export interface OpenAiCompatServerHandle {
  host: string
  port: number
  token: string
  baseURL: string
  close: () => Promise<void>
}

interface ChatCompletionRequest {
  model: string
  messages: unknown[]
  tools?: unknown[] | undefined
  stream?: boolean | undefined
  stream_options?: { include_usage?: boolean | undefined } | undefined
}

export async function startOpenAiCompatServer(options: OpenAiCompatServerOptions): Promise<OpenAiCompatServerHandle> {
  const host = options.host ?? "127.0.0.1"
  const token = options.token ?? randomBytes(24).toString("base64url")
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      ...options,
      host,
      token,
    }).catch((err) => {
      sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: "server_error",
        },
      })
    })
  })

  await listen(server, options.port ?? 0, host)
  const address = server.address() as AddressInfo
  const port = address.port
  return {
    host,
    port,
    token,
    baseURL: `http://${host}:${port}/v1`,
    close: () => closeServer(server),
  }
}

interface RequestContext extends OpenAiCompatServerOptions {
  host: string
  token: string
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const method = req.method ?? "GET"
  const url = new URL(req.url ?? "/", `http://${ctx.host}`)

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" })
    return
  }

  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } })
    return
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: ctx.models.map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "opencode-anycli",
      })),
    })
    return
  }

  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readJsonBody(req)
    await handleChatCompletion(req, res, ctx, body)
    return
  }

  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } })
}

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  body: unknown,
): Promise<void> {
  if (!isRecord(body)) {
    sendJson(res, 400, { error: { message: "Expected JSON object body", type: "invalid_request_error" } })
    return
  }

  const parsed = normalizeChatCompletionRequest(body)
  if (typeof parsed === "string") {
    sendJson(res, 400, { error: { message: parsed, type: "invalid_request_error" } })
    return
  }

  const abort = new AbortController()
  const abortTurn = (): void => {
    if (!res.writableEnded) abort.abort()
  }
  req.on("close", abortTurn)
  res.on("close", abortTurn)

  const prompt = openAiMessagesToPrompt(parsed.messages)
  const tools = openAiToolsToProtocolTools(parsed.tools ?? [])
  const turnRequest: ClineTurnRequest = {
    prompt,
    tools,
    modelId: parsed.model,
    signal: abort.signal,
    config: ctx.config,
    previousToolCalls: previousToolCallsFromMessages(parsed.messages),
  }

  if (parsed.stream === true) {
    await streamChatCompletion(res, parsed, turnRequest, ctx.runTurn)
    return
  }

  const result = ctx.runTurn
    ? await collectRunTurn(ctx.runTurn(turnRequest))
    : await runClineTurnOnce(turnRequest)
  sendJson(res, 200, chatCompletionResponse(parsed.model, result.text, result.opencodeCalls, result.usage))
}

export function openAiToolsToProtocolTools(tools: readonly unknown[]): ProtocolToolDescriptor[] {
  const out: ProtocolToolDescriptor[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    if (tool["type"] !== "function") continue
    const fn = tool["function"]
    if (!isRecord(fn) || typeof fn["name"] !== "string") continue
    out.push({ name: fn["name"] })
  }
  return out
}

function previousToolCallsFromMessages(messages: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue
    const toolCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : []
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue
      const fn = toolCall["function"]
      if (!isRecord(fn) || typeof fn["name"] !== "string") continue
      out.add(createToolCallSignature(fn["name"], parseToolArguments(fn["arguments"])))
    }
  }
  return out
}

export function openAiMessagesToPrompt(messages: readonly unknown[]): unknown[] {
  const toolNamesById = new Map<string, string>()
  const prompt: unknown[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = typeof message["role"] === "string" ? message["role"] : "user"
    if (role === "assistant") {
      const parts: unknown[] = []
      const text = contentToText(message["content"])
      if (text.length > 0) parts.push({ type: "text", text })

      const toolCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : []
      for (const call of toolCalls) {
        if (!isRecord(call)) continue
        const id = typeof call["id"] === "string" ? call["id"] : randomUUID()
        const fn = isRecord(call["function"]) ? call["function"] : {}
        const toolName = typeof fn["name"] === "string" ? fn["name"] : "tool"
        toolNamesById.set(id, toolName)
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName,
          input: parseToolArguments(fn["arguments"]),
        })
      }

      prompt.push({ role, content: parts.length > 0 ? parts : text })
      continue
    }

    if (role === "tool") {
      const toolCallId = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : randomUUID()
      const toolName = typeof message["name"] === "string" ? message["name"] : (toolNamesById.get(toolCallId) ?? "tool")
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            output: contentToText(message["content"]),
          },
        ],
      })
      continue
    }

    prompt.push({ role, content: message["content"] ?? "" })
  }

  return prompt
}

async function streamChatCompletion(
  res: ServerResponse,
  request: ChatCompletionRequest,
  turnRequest: ClineTurnRequest,
  runTurn: OpenAiCompatServerOptions["runTurn"],
): Promise<void> {
  const id = chatId()
  const created = createdNow()
  const calls: Array<{ id: string; toolName: string; input: unknown }> = []
  let usage = emptyClineUsage()
  let finished = false

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n")
  }, 15_000)

  try {
    writeSse(res, chatChunk(id, created, request.model, { role: "assistant" }))
    for await (const event of runTurn ? runTurn(turnRequest) : runClineTurn(turnRequest)) {
      if (event.type === "text-delta") {
        writeSse(res, chatChunk(id, created, request.model, { content: event.delta }))
      } else if (event.type === "opencode-call") {
        const index = calls.length
        calls.push({ id: event.id, toolName: event.toolName, input: event.input })
        writeSse(
          res,
          chatChunk(id, created, request.model, {
            tool_calls: [
              {
                index,
                id: event.id,
                type: "function",
                function: { name: event.toolName, arguments: JSON.stringify(event.input ?? {}) },
              },
            ],
          }),
        )
      } else if (event.type === "finish") {
        usage = event.usage
        const finishReason = calls.length > 0 ? "tool_calls" : "stop"
        writeSse(res, chatChunk(id, created, request.model, {}, finishReason))
        finished = true
      } else if (event.type === "error") {
        writeSse(res, { error: { message: event.error.message, type: "server_error" } })
        finished = true
      }
    }

    if (!finished) writeSse(res, chatChunk(id, created, request.model, {}, calls.length > 0 ? "tool_calls" : "stop"))
    if (request.stream_options?.include_usage === true) {
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [],
        usage: toOpenAiUsage(usage),
      })
    }
    res.write("data: [DONE]\n\n")
    res.end()
  } finally {
    clearInterval(keepAlive)
  }
}

async function collectRunTurn(events: AsyncIterable<ClineTurnEvent>): Promise<{
  text: string
  opencodeCalls: Array<{ id: string; toolName: string; input: unknown }>
  usage: ClineUsage
}> {
  let text = ""
  const opencodeCalls: Array<{ id: string; toolName: string; input: unknown }> = []
  let usage = emptyClineUsage()
  for await (const event of events) {
    if (event.type === "text-delta") text += event.delta
    else if (event.type === "opencode-call") opencodeCalls.push({ id: event.id, toolName: event.toolName, input: event.input })
    else if (event.type === "finish") usage = event.usage
    else if (event.type === "error") throw event.error
  }
  return { text, opencodeCalls, usage }
}

function chatCompletionResponse(
  model: string,
  text: string,
  calls: Array<{ id: string; toolName: string; input: unknown }>,
  usage: ClineUsage,
): JsonRecord {
  const message: JsonRecord = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  }
  if (calls.length > 0) {
    message["tool_calls"] = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
    }))
  }
  return {
    id: chatId(),
    object: "chat.completion",
    created: createdNow(),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
    usage: toOpenAiUsage(usage),
  }
}

function chatChunk(
  id: string,
  created: number,
  model: string,
  delta: JsonRecord,
  finishReason: string | null = null,
): JsonRecord {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function normalizeChatCompletionRequest(body: JsonRecord): ChatCompletionRequest | string {
  if (typeof body["model"] !== "string") return "model must be a string"
  if (!Array.isArray(body["messages"])) return "messages must be an array"
  return {
    model: body["model"],
    messages: body["messages"],
    tools: Array.isArray(body["tools"]) ? body["tools"] : undefined,
    stream: body["stream"] === true,
    stream_options: isRecord(body["stream_options"]) ? { include_usage: body["stream_options"]["include_usage"] === true } : undefined,
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  if (!Array.isArray(content)) return JSON.stringify(content)
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === "string") parts.push(part)
    else if (isRecord(part) && typeof part["text"] === "string") parts.push(part["text"])
  }
  return parts.join("")
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function toOpenAiUsage(usage: ClineUsage): JsonRecord {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const completionTokens = usage.outputTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens || promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  }
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : {}
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

function chatId(): string {
  return `chatcmpl-${randomUUID()}`
}

function createdNow(): number {
  return Math.floor(Date.now() / 1000)
}
