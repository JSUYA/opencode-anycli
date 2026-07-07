import { afterEach, describe, expect, it } from "vitest"

import {
  emptyClineUsage,
  openAiMessagesToPrompt,
  startOpenAiCompatServer,
  type ClineTurnEvent,
  type OpenAiCompatServerHandle,
} from "../src/index.js"
import { composeClineHandoff } from "../src/cline-handoff.js"
import { isSkillAlreadyDispatchedInHandoff } from "../src/opencode-call-parser.js"

const handles: OpenAiCompatServerHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

describe("openai-compatible facade", () => {
  it("serves health without auth and protects OpenAI endpoints", async () => {
    const handle = await startTestServer([])

    const health = await fetch(`http://${handle.host}:${handle.port}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "ok" })

    const models = await fetch(`${handle.baseURL}/models`)
    expect(models.status).toBe(401)
  })

  it("normalizes OpenAI assistant tool calls and tool results into handoff prompt parts", () => {
    const prompt = openAiMessagesToPrompt([
      { role: "user", content: "use a tool" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "skill", arguments: "{\"name\":\"code-review\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "loaded" },
      { role: "user", content: "continue" },
    ])

    expect(prompt).toMatchObject([
      { role: "user", content: "use a tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "call_1", toolName: "skill", input: { name: "code-review" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "skill", output: "loaded" }],
      },
      { role: "user", content: "continue" },
    ])

    const handoff = composeClineHandoff({ prompt, tools: [{ name: "skill" }] }).text
    expect(handoff).toContain('<tool-call name="skill">{"name":"code-review"}</tool-call>')
    expect(isSkillAlreadyDispatchedInHandoff(handoff, "code-review")).toBe(true)
  })

  it("serves non-stream text completions with usage", async () => {
    const handle = await startTestServer([
      { type: "text-delta", delta: "hello" },
      { type: "finish", finishReason: "stop", usage: usage(3, 2) },
    ])

    const res = await postChat(handle, { model: "GaussO4.1-CLI", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe("hello")
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.usage.prompt_tokens).toBe(3)
    expect(body.usage.completion_tokens).toBe(2)
  })

  it("maps opencode calls to OpenAI tool_calls", async () => {
    const handle = await startTestServer([
      { type: "opencode-call", id: "call_skill", toolName: "skill", input: { name: "karpathy-guidelines" } },
      { type: "finish", finishReason: "tool-calls", usage: usage(1, 0) },
    ])

    const res = await postChat(handle, {
      model: "GaussO4.1-CLI",
      messages: [{ role: "user", content: "/karpathy" }],
      tools: [{ type: "function", function: { name: "skill", parameters: { type: "object" } } }],
    })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("tool_calls")
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        id: "call_skill",
        type: "function",
        function: { name: "skill", arguments: "{\"name\":\"karpathy-guidelines\"}" },
      },
    ])
  })

  it("streams text, tool calls, usage, and DONE as SSE chunks", async () => {
    const handle = await startTestServer([
      { type: "text-delta", delta: "a" },
      { type: "opencode-call", id: "call_task", toolName: "task", input: { subagent_type: "build", description: "do work", prompt: "go" } },
      { type: "finish", finishReason: "tool-calls", usage: usage(5, 7) },
    ])

    const res = await postChat(handle, {
      model: "GaussO4.1-CLI",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "@build go" }],
      tools: [{ type: "function", function: { name: "task", parameters: { type: "object" } } }],
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    const events = parseSse(text)
    expect(events.at(-1)).toBe("[DONE]")

    const chunks = events.slice(0, -1).map((event) => JSON.parse(event))
    expect(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === "a")).toBe(true)
    expect(chunks.some((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "task")).toBe(true)
    expect(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls")).toBe(true)
    expect(chunks.some((chunk) => chunk.usage?.prompt_tokens === 5 && chunk.choices?.length === 0)).toBe(true)
  })

  it("aborts the turn signal when a streaming client disconnects", async () => {
    let abortResolved!: () => void
    const aborted = new Promise<void>((resolve) => {
      abortResolved = resolve
    })
    const handle = await startOpenAiCompatServer({
      models: [{ id: "GaussO4.1-CLI" }],
      token: "test-token",
      runTurn: async function* (request) {
        yield { type: "text-delta", delta: "start" }
        request.signal?.addEventListener("abort", abortResolved, { once: true })
        await aborted
        yield { type: "finish", finishReason: "stop", usage: emptyClineUsage() }
      },
    })
    handles.push(handle)

    const controller = new AbortController()
    const res = await fetch(`${handle.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "GaussO4.1-CLI",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await reader!.read()
    await reader!.cancel()
    controller.abort()
    await aborted
  })
})

async function startTestServer(events: ClineTurnEvent[]): Promise<OpenAiCompatServerHandle> {
  const handle = await startOpenAiCompatServer({
    models: [{ id: "GaussO4.1-CLI" }],
    token: "test-token",
    runTurn: async function* () {
      for (const event of events) yield event
    },
  })
  handles.push(handle)
  return handle
}

function postChat(handle: OpenAiCompatServerHandle, body: unknown): Promise<Response> {
  return fetch(`${handle.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    ...emptyClineUsage(),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

function parseSse(text: string): string[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
}
