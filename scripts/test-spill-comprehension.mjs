#!/usr/bin/env node
// test-spill-comprehension.mjs — verifies that the temp-file spill path
// PRESERVES SEMANTICS, not just round-trips a marker. Tests:
//
//   1. equivalence: same prompt, run with argv path AND with forced spill;
//      both responses should agree on the deterministic answer.
//   2. needle-at-start / needle-at-end: a unique token placed at the top
//      vs bottom of a long prompt — verifies cline reads the WHOLE file
//      (not just the first chunk).
//   3. multi-fact retrieval: 3 distinct facts scattered through padding;
//      cline should report all three.
//   4. instruction-vs-padding: verifies the model follows the embedded
//      user instruction and ignores the redirection wrapper text.
//
// Each test runs against the real cline binary. We toggle spill via
// OPENCODE_ANYCLI_ARGV_LIMIT so we can force argv or temp-file path
// independently of prompt size.
//
// Usage:
//   node scripts/test-spill-comprehension.mjs            # all tests
//   node scripts/test-spill-comprehension.mjs --quick    # subset
//   node scripts/test-spill-comprehension.mjs --case=needle-end

import { runOnce } from "../packages/provider-cline-cli/dist/index.js"
import { randomBytes } from "node:crypto"

const KB = 1024
const argv = new Set(process.argv.slice(2))
const QUICK = argv.has("--quick")
const FILTER = [...argv].find((a) => a.startsWith("--case="))?.slice("--case=".length) ?? ""

const RESET = "\x1b[0m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

const ARGV_HUGE = "999999999" // effectively never spill — forces argv path
const ARGV_TINY = "256"        // force spill on anything bigger than 256 B

function randMarker(prefix = "MARK") {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`
}

// Padding generator — distinct content blocks so each region of the prompt
// has different bytes (prevents accidental "the same chunk appears 100x" trick).
function paddingBlock(label, bytes) {
  const seg = `[${label}] lorem ipsum dolor sit amet, consectetur adipiscing elit. `
  const reps = Math.ceil(bytes / Buffer.byteLength(seg, "utf8"))
  return seg.repeat(reps).slice(0, bytes)
}

// ─── tests ────────────────────────────────────────────────────────────────────

const TESTS = [
  // ── 1. Equivalence: argv vs forced-spill on same prompt ────────────────────
  {
    name: "equivalence-50kb",
    runBoth: true,
    sizeBytes: 50 * KB,
    build() {
      const a = Math.floor(Math.random() * 100) + 50
      const b = Math.floor(Math.random() * 100) + 50
      const c = Math.floor(Math.random() * 100) + 50
      const expected = String(a + b + c)
      const head = [
        `ANSWER QUESTION CAREFULLY.`,
        ``,
        `Question: What is ${a} + ${b} + ${c}?`,
        ``,
        `Respond with ONLY the integer answer. No words, no punctuation, no explanation.`,
        ``,
        `--- the rest of this document is filler; ignore it ---`,
        ``,
      ].join("\n")
      const padding = paddingBlock("filler", 50 * KB - Buffer.byteLength(head, "utf8"))
      return { prompt: head + padding, expected }
    },
    verify(text, { expected }) {
      const trimmed = text.trim()
      const matches = trimmed.match(/-?\d+/g) ?? []
      const present = matches.includes(expected)
      const leaks = collectLeaks(trimmed)
      const ok = present && leaks.length === 0
      return {
        ok,
        detail: ok
          ? `got ${expected}`
          : !present
          ? `expected ${expected}, raw="${trimmed.slice(0, 100)}"`
          : `${YELLOW}got ${expected} BUT leaks: ${leaks.join(", ")}${RESET}`,
      }
    },
  },

  // ── 2a. Needle at start of long prompt ─────────────────────────────────────
  {
    name: "needle-at-start-100kb",
    forceSpill: true,
    build() {
      const needle = randMarker("HEADTOK")
      const head = [
        `IMPORTANT: A unique token appears EARLY in this document: ${needle}`,
        ``,
        `Find that token and respond with ONLY the token. No prefix, no suffix, no explanation.`,
        ``,
        `--- filler below; ignore it ---`,
        ``,
      ].join("\n")
      const padding = paddingBlock("zzz-tail-filler", 100 * KB - Buffer.byteLength(head, "utf8"))
      return { prompt: head + padding, needle }
    },
    verify(text, { needle }) {
      return verifyTokenStrict(text, needle)
    },
  },

  // ── 2b. Needle at MIDDLE of long prompt ────────────────────────────────────
  {
    name: "needle-at-middle-100kb",
    forceSpill: true,
    build() {
      const needle = randMarker("MIDTOK")
      const head = [
        `Somewhere in this long document is a unique token starting with "MIDTOK-".`,
        `Find it and respond with ONLY that token (no prefix, no suffix, no explanation).`,
        ``,
        `--- begin document ---`,
        ``,
      ].join("\n")
      const halfPadBytes = (100 * KB - Buffer.byteLength(head, "utf8")) / 2 - 200
      const before = paddingBlock("aaa-pre-needle", halfPadBytes)
      const center = `\n\n=== MARKER LINE === ${needle} === END MARKER ===\n\n`
      const after = paddingBlock("zzz-post-needle", halfPadBytes)
      return { prompt: head + before + center + after, needle }
    },
    verify(text, { needle }) {
      return verifyTokenStrict(text, needle)
    },
  },

  // ── 2c. Needle at END of long prompt — most aggressive test ────────────────
  // If cline only reads the FIRST chunk of a long file (e.g., default 500-line
  // limit), this test fails. That would be a real bug in our spill design.
  {
    name: "needle-at-end-100kb",
    forceSpill: true,
    build() {
      const needle = randMarker("TAILTOK")
      const head = [
        `At the very END of this document is a unique token starting with "TAILTOK-".`,
        `Find it and respond with ONLY that token (no prefix, no suffix, no explanation).`,
        ``,
        `--- begin filler ---`,
        ``,
      ].join("\n")
      const padding = paddingBlock("aaa-bulk-filler", 100 * KB - Buffer.byteLength(head, "utf8") - 200)
      const tail = `\n\n--- end of filler ---\n\n=== FINAL TOKEN === ${needle}\n`
      return { prompt: head + padding + tail, needle }
    },
    verify(text, { needle }) {
      return verifyTokenStrict(text, needle)
    },
  },

  // ── 3. Multi-fact retrieval ────────────────────────────────────────────────
  {
    name: "multi-fact-100kb",
    forceSpill: true,
    build() {
      const facts = [
        { key: "Alpha", value: randMarker("V1") },
        { key: "Beta", value: randMarker("V2") },
        { key: "Gamma", value: randMarker("V3") },
      ]
      const head = [
        `Three FACT lines are scattered through this document.`,
        `Each FACT line has the form: FACT <key>=<value>`,
        ``,
        `Find all three facts and respond with EXACTLY three lines, one per fact, in this format:`,
        `<key>=<value>`,
        `(no extra text, no explanation, one fact per line)`,
        ``,
      ].join("\n")
      const segBytes = (100 * KB - Buffer.byteLength(head, "utf8")) / 3 - 200
      const seg1 = paddingBlock("seg1-pad", segBytes)
      const seg2 = paddingBlock("seg2-pad", segBytes)
      const seg3 = paddingBlock("seg3-pad", segBytes)
      const prompt =
        head +
        seg1 +
        `\n\nFACT ${facts[0].key}=${facts[0].value}\n\n` +
        seg2 +
        `\n\nFACT ${facts[1].key}=${facts[1].value}\n\n` +
        seg3 +
        `\n\nFACT ${facts[2].key}=${facts[2].value}\n`
      return { prompt, facts }
    },
    verify(text, { facts }) {
      const found = facts.filter((f) => text.includes(`${f.key}=${f.value}`))
      const missing = facts.filter((f) => !text.includes(`${f.key}=${f.value}`))
      const leaks = collectLeaks(text)
      const ok = found.length === facts.length && leaks.length === 0
      return {
        ok,
        detail: ok
          ? `found all ${facts.length}`
          : leaks.length > 0
          ? `${YELLOW}all 3 found BUT leaks: ${leaks.join(", ")}${RESET}`
          : `found ${found.length}/${facts.length}, missing: ${missing.map((m) => `${m.key}=${m.value}`).join(", ")}`,
      }
    },
  },

  // ── 4. Wrapper-vs-instruction discrimination ───────────────────────────────
  // Embedded instruction asks for SPECIFIC answer. Strict checks:
  //   (a) answer token must appear,
  //   (b) NO temp file path in response (path leak),
  //   (c) NO renderer marker in response (`[cline:readFile]`),
  //   (d) NO redirection narrative in response (model talking about file/redirect).
  // Reasoning preamble is tolerated — it's a sporadic pre-existing cline
  // behavior unrelated to spill — but the answer must still be present.
  {
    name: "instruction-vs-wrapper-50kb",
    forceSpill: true,
    build() {
      const code = randMarker("AUTH")
      const head = [
        `You are answering a question. The question is below.`,
        ``,
        `QUESTION: What is the authentication code mentioned in this document?`,
        `The authentication code is: ${code}`,
        ``,
        `Respond with ONLY the authentication code (just the token, no other text).`,
        ``,
      ].join("\n")
      const padding = paddingBlock("filler-content", 50 * KB - Buffer.byteLength(head, "utf8"))
      return { prompt: head + padding, code }
    },
    verify(text, { code }) {
      return verifyTokenStrict(text, code, { kind: "AUTH" })
    },
  },

  // ── 5. Adversarial transformation — can't be solved by keyword grep ────────
  // The answer is computed from input, not retrieved. Verifies the model
  // actually processes the prompt, not just searches for keywords near the
  // question.
  {
    name: "adversarial-transform-50kb",
    forceSpill: true,
    build() {
      // Pick three random words; expected output applies a 3-step transform.
      const words = ["RED", "GREEN", "BLUE"]
      const head = [
        `Take exactly these three words: ${words.join(", ")}.`,
        `Apply these transformations IN ORDER:`,
        `  1. Reverse the order.`,
        `  2. Lowercase each word.`,
        `  3. Join with hyphens.`,
        `Respond with ONLY the result. No explanation.`,
        ``,
      ].join("\n")
      const padding = paddingBlock("filler-padding", 50 * KB - Buffer.byteLength(head, "utf8"))
      // Expected: blue-green-red
      const expected = words.slice().reverse().map((w) => w.toLowerCase()).join("-")
      return { prompt: head + padding, expected }
    },
    verify(text, { expected }) {
      const trimmed = text.trim()
      const present = trimmed.includes(expected)
      const leaks = collectLeaks(trimmed)
      const ok = present && leaks.length === 0
      return {
        ok,
        detail: ok
          ? `produced "${expected}"`
          : !present
          ? `expected "${expected}", raw="${trimmed.slice(0, 120)}"`
          : `${YELLOW}produced "${expected}" BUT leaks: ${leaks.join(", ")}${RESET}`,
      }
    },
  },

  // ── 6. Multi-instruction sequencing — file contains multiple distinct asks ─
  // Verifies the model processes ALL instructions in the file, not just the
  // first or last one.
  {
    name: "multi-instruction-50kb",
    forceSpill: true,
    build() {
      const a = Math.floor(Math.random() * 50) + 10
      const b = Math.floor(Math.random() * 50) + 10
      const word = "TEST"
      const head = [
        `This document contains THREE separate small tasks. Complete all three.`,
        ``,
        `Task 1: Compute ${a} + ${b}.`,
        `Task 2: Reverse the word "${word}".`,
        `Task 3: Output the uppercase letter that comes 5 positions after 'A' in the alphabet.`,
        ``,
        `Respond with EXACTLY three lines, in order, one answer per line. No labels, no extra text.`,
        ``,
      ].join("\n")
      const padding = paddingBlock("filler-noise", 50 * KB - Buffer.byteLength(head, "utf8"))
      const expected = [String(a + b), word.split("").reverse().join(""), "F"]
      return { prompt: head + padding, expected }
    },
    verify(text, { expected }) {
      const trimmed = text.trim()
      const found = expected.filter((e) => trimmed.includes(e))
      const leaks = collectLeaks(trimmed)
      const ok = found.length === expected.length && leaks.length === 0
      const missing = expected.filter((e) => !trimmed.includes(e))
      return {
        ok,
        detail: ok
          ? `all 3 tasks: ${expected.join(" / ")}`
          : leaks.length > 0
          ? `${YELLOW}leaks: ${leaks.join(", ")}${RESET}`
          : `missing: ${missing.join(", ")}, raw="${trimmed.slice(0, 120)}"`,
      }
    },
  },
]

// ─── strict verifier helpers ──────────────────────────────────────────────────
function verifyTokenStrict(text, expected, { kind } = {}) {
  const trimmed = text.trim()
  const present = trimmed.includes(expected)
  const leaks = collectLeaks(trimmed)
  const ok = present && leaks.length === 0
  if (!present) {
    return { ok: false, detail: `missing ${expected}, raw="${trimmed.slice(0, 120)}"` }
  }
  if (leaks.length > 0) {
    return {
      ok: false,
      detail: `${YELLOW}found ${expected} BUT leaks: ${leaks.join(", ")}${RESET}`,
    }
  }
  return { ok: true, detail: `found ${expected}${kind ? ` (${kind})` : ""}` }
}

/**
 * Collect leak signatures the model should NEVER emit:
 *   - our spill temp dir
 *   - the readFile tool-call renderer marker
 *   - any "cline:" tool prefix
 *   - the wrapper's "redirection" sentinel
 *   - file/redirect/wrapper meta-narrative
 */
function collectLeaks(text) {
  const leaks = []
  if (/\/tmp\/opencode-anycli-prompts\//i.test(text)) leaks.push("tmp-path")
  if (/\[cline:readFile\]/i.test(text)) leaks.push("readFile-marker")
  if (/\[cline:[a-z]+\]/i.test(text)) leaks.push("cline-tool-marker")
  if (/opencode-anycli redirection/i.test(text)) leaks.push("redirection-sentinel")
  // model-narrated meta phrases (only flag obvious ones — too aggressive
  // here would false-positive on innocent reasoning text).
  if (/(?:I|let me) (?:read|open) (?:the|that) file/i.test(text)) leaks.push("file-narration")
  if (/(?:redirected|redirection) (?:to|via) (?:a|the|that) file/i.test(text)) leaks.push("redirect-narration")
  return leaks
}

// ─── runner ───────────────────────────────────────────────────────────────────
async function runOnceWithLimit(prompt, limit) {
  const prevLimit = process.env["OPENCODE_ANYCLI_ARGV_LIMIT"]
  process.env["OPENCODE_ANYCLI_ARGV_LIMIT"] = limit
  try {
    return await runOnce({
      prompt,
      options: { command: "cline", timeoutMs: 240_000 },
    })
  } finally {
    if (prevLimit === undefined) delete process.env["OPENCODE_ANYCLI_ARGV_LIMIT"]
    else process.env["OPENCODE_ANYCLI_ARGV_LIMIT"] = prevLimit
  }
}

async function runTest(t) {
  const built = t.build()
  const promptBytes = Buffer.byteLength(built.prompt, "utf8")
  const results = []

  if (t.runBoth) {
    // Equivalence: argv first, then forced spill.
    const a = await runOnceWithLimit(built.prompt, ARGV_HUGE)
    const aVerify = t.verify(a.text, built)
    results.push({ route: "argv", text: a.text, ok: aVerify.ok, detail: aVerify.detail })

    const b = await runOnceWithLimit(built.prompt, ARGV_TINY)
    const bVerify = t.verify(b.text, built)
    results.push({ route: "spill", text: b.text, ok: bVerify.ok, detail: bVerify.detail })
  } else if (t.forceSpill) {
    const r = await runOnceWithLimit(built.prompt, ARGV_TINY)
    const v = t.verify(r.text, built)
    results.push({ route: "spill", text: r.text, ok: v.ok, detail: v.detail })
  } else {
    const r = await runOnceWithLimit(built.prompt, ARGV_HUGE)
    const v = t.verify(r.text, built)
    results.push({ route: "argv", text: r.text, ok: v.ok, detail: v.detail })
  }
  return { name: t.name, promptBytes, results }
}

function shouldRun(name) {
  if (FILTER && !name.includes(FILTER)) return false
  if (QUICK && !["equivalence-50kb", "needle-at-end-100kb", "multi-fact-100kb"].includes(name)) return false
  return true
}

console.log(`${BOLD}opencode-anycli — spill comprehension matrix${RESET}`)
console.log(`${DIM}cases=${TESTS.filter((t) => shouldRun(t.name)).length}  ${QUICK ? "[QUICK]" : ""}${FILTER ? ` filter="${FILTER}"` : ""}${RESET}\n`)

const allResults = []
for (const t of TESTS) {
  if (!shouldRun(t.name)) continue
  process.stdout.write(`${BOLD}${t.name}${RESET}  (${(0).toString()}…")\r`)
  try {
    const out = await runTest(t)
    allResults.push(out)
    console.log(`${BOLD}${t.name}${RESET}  ${DIM}(${out.promptBytes} bytes)${RESET}`)
    for (const r of out.results) {
      const glyph = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
      console.log(`  ${glyph} [${r.route}] ${r.detail}`)
    }
    console.log("")
  } catch (err) {
    console.log(`${RED}✗${RESET} ${t.name} THREW: ${err?.message ?? String(err)}`)
    allResults.push({ name: t.name, results: [{ route: "?", ok: false, detail: String(err) }] })
  }
}

const totalChecks = allResults.reduce((acc, r) => acc + r.results.length, 0)
const passChecks = allResults.reduce((acc, r) => acc + r.results.filter((x) => x.ok).length, 0)
console.log(`${BOLD}summary${RESET}: ${passChecks}/${totalChecks} checks passed across ${allResults.length} tests`)

// Equivalence check: for runBoth tests, both routes should produce ok=true
for (const r of allResults) {
  if (r.results.length === 2) {
    const [a, b] = r.results
    if (a.ok !== b.ok) {
      console.log(`${RED}DIVERGENCE${RESET} in ${r.name}: argv=${a.ok ? "ok" : "FAIL"} / spill=${b.ok ? "ok" : "FAIL"}`)
    }
  }
}

process.exit(passChecks === totalChecks ? 0 : 1)
