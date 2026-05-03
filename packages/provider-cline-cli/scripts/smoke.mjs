#!/usr/bin/env node
// End-to-end smoke test against the locally-installed cline CLI.
// This makes a REAL LLM call using whichever provider cline is configured for.
// Usage: node scripts/smoke.mjs

import { createCline } from "../dist/index.js"

const TIMEOUT_MS = 90_000
const PROMPT = "Reply with just the single word: pong"

const provider = createCline({
  command: process.env.OPENCLINECLICODE_CLINE_BIN || "cline",
  timeoutMs: TIMEOUT_MS,
})
const model = provider.languageModel("default")

console.log(`[smoke] specVersion=${model.specificationVersion} provider=${model.provider} modelId=${model.modelId}`)
console.log(`[smoke] invoking cline subprocess (timeout ${TIMEOUT_MS}ms)…`)

const t0 = Date.now()
const result = await model.doGenerate({
  prompt: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
})
const dt = Date.now() - t0

const textParts = result.content.filter((c) => c.type === "text").map((c) => c.text)
const text = textParts.join("")

console.log(`[smoke] elapsed=${dt}ms`)
console.log(`[smoke] finishReason=${JSON.stringify(result.finishReason)}`)
console.log(`[smoke] usage=${JSON.stringify(result.usage)}`)
console.log(`[smoke] providerMetadata=${JSON.stringify(result.providerMetadata)}`)
console.log(`[smoke] response.id=${result.response?.id}`)
console.log(`[smoke] text (${text.length} chars):`)
console.log("---")
console.log(text)
console.log("---")

if (text.length === 0) {
  console.error("[smoke] FAIL: empty text returned")
  process.exit(1)
}
console.log("[smoke] PASS")
