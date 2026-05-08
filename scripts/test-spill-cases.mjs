#!/usr/bin/env node
// test-spill-cases.mjs — end-to-end verification of the prompt-spill path with
// the *real* cline binary. For each case we wrap a unique MARKER + a "respond
// with only the marker" instruction in a prompt of the requested size, run it
// through runOnce, and check whether cline echoed the marker back.
//
// Usage:
//   node scripts/test-spill-cases.mjs                # full matrix
//   node scripts/test-spill-cases.mjs --quick        # short cases only
//   node scripts/test-spill-cases.mjs --case=200kb   # filter by name substring
//
// Cost note: each case spawns a real cline turn. With the marker-only
// responses below this is ~1 short LLM call per case.

import { runOnce } from "../packages/provider-cline-cli/dist/index.js"
import { randomBytes } from "node:crypto"

const KB = 1024
const argv = new Set(process.argv.slice(2))
const QUICK = argv.has("--quick")
const FILTER = [...argv].find((a) => a.startsWith("--case="))?.slice("--case=".length) ?? ""

// ─── prompt builders ──────────────────────────────────────────────────────────
function buildPrompt({ marker, sizeBytes, lang }) {
  // The instruction must be unambiguous AND short, so even after spill cline's
  // wrapper says "treat the file as the user request", the file's first line
  // sets context loud and clear. Padding is appended below an "ignore" line.
  const head = [
    `RESPOND WITH EXACTLY THIS TOKEN AND NOTHING ELSE: ${marker}`,
    `Do not add any prefix, suffix, explanation, or punctuation.`,
    `--- ignore everything below this line ---`,
    "",
  ].join("\n")
  const remaining = Math.max(0, sizeBytes - Buffer.byteLength(head, "utf8"))
  const padding = makePadding(remaining, lang)
  return head + padding
}

function makePadding(targetBytes, lang) {
  if (targetBytes <= 0) return ""
  if (lang === "ko") {
    // 한글 1자 = 3 bytes UTF-8
    const chars = Math.floor(targetBytes / 3)
    return "패딩".repeat(Math.ceil(chars / 2)).slice(0, chars)
  }
  if (lang === "code") {
    const block = "function f(x) {\n  return x + 1\n}\n\n"
    const reps = Math.ceil(targetBytes / Buffer.byteLength(block, "utf8"))
    return block.repeat(reps).slice(0, targetBytes)
  }
  if (lang === "mixed") {
    const block = "Hello 안녕 🚀 ABC123 — "
    const reps = Math.ceil(targetBytes / Buffer.byteLength(block, "utf8"))
    return block.repeat(reps).slice(0, targetBytes)
  }
  // ascii default
  return "x".repeat(targetBytes)
}

// ─── case matrix ──────────────────────────────────────────────────────────────
// Sizes chosen to straddle the default 96 KiB threshold and exercise both
// argv and temp-file paths. The largest entries (300 KB, 500 KB) would have
// hit E2BIG before this fix.
const ALL_CASES = [
  { name: "tiny-ascii",       sizeBytes: 200,         lang: "ascii", expectSpill: false },
  { name: "10kb-ascii",       sizeBytes: 10 * KB,     lang: "ascii", expectSpill: false },
  { name: "50kb-ascii",       sizeBytes: 50 * KB,     lang: "ascii", expectSpill: false },
  { name: "90kb-ascii",       sizeBytes: 90 * KB,     lang: "ascii", expectSpill: false },
  { name: "100kb-ascii",      sizeBytes: 100 * KB,    lang: "ascii", expectSpill: true  },
  { name: "150kb-korean",     sizeBytes: 150 * KB,    lang: "ko",    expectSpill: true  },
  { name: "200kb-code",       sizeBytes: 200 * KB,    lang: "code",  expectSpill: true  },
  { name: "300kb-mixed",      sizeBytes: 300 * KB,    lang: "mixed", expectSpill: true  },
  { name: "500kb-ascii",      sizeBytes: 500 * KB,    lang: "ascii", expectSpill: true  },
]

const QUICK_CASES = ["tiny-ascii", "100kb-ascii", "200kb-code"]

const cases = ALL_CASES.filter((c) => {
  if (FILTER && !c.name.includes(FILTER)) return false
  if (QUICK && !QUICK_CASES.includes(c.name)) return false
  return true
})

// ─── runner ───────────────────────────────────────────────────────────────────
const ARGV_LIMIT = 96 * KB // mirror the runtime default

const RESET = "\x1b[0m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

function fmt(n) { return n.toString().padStart(8, " ") }

function printHeader() {
  console.log(`${BOLD}case-name${RESET}              size(B)   lang    routing      ms        ok    notes`)
  console.log("-".repeat(100))
}

async function runCase(c) {
  const marker = `MARK-${randomBytes(6).toString("hex").toUpperCase()}`
  const prompt = buildPrompt({ marker, sizeBytes: c.sizeBytes, lang: c.lang })
  const actualBytes = Buffer.byteLength(prompt, "utf8")
  const wouldSpill = actualBytes > ARGV_LIMIT
  const routing = wouldSpill ? "tempfile" : "argv"

  const start = Date.now()
  let ok = false
  let notes = ""
  let snippet = ""
  try {
    const result = await runOnce({
      prompt,
      options: { command: "cline", timeoutMs: 180_000 },
    })
    snippet = (result.text ?? "").trim()
    ok = snippet.includes(marker)
    if (!ok) notes = `marker missing; got "${snippet.slice(0, 60).replace(/\n/g, "\\n")}…"`
  } catch (err) {
    notes = `THROW: ${err?.message ?? String(err)}`
  }
  const elapsed = Date.now() - start

  const okGlyph = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  const expectMatch = wouldSpill === c.expectSpill
  const routingMark = expectMatch ? routing : `${RED}${routing}!${RESET}`
  console.log(
    `${c.name.padEnd(22, " ")} ${fmt(actualBytes)}  ${c.lang.padEnd(5, " ")}  ${routingMark.padEnd(20, " ")} ${fmt(elapsed)}  ${okGlyph}    ${notes}`,
  )
  return { name: c.name, ok, actualBytes, routing, elapsed, expected: c.expectSpill === wouldSpill, notes }
}

// ─── main ─────────────────────────────────────────────────────────────────────
console.log(`${BOLD}opencode-anycli — prompt spill case matrix${RESET}`)
console.log(`${DIM}cases=${cases.length}  threshold=${ARGV_LIMIT}B  ${QUICK ? "[QUICK]" : ""}${FILTER ? ` filter="${FILTER}"` : ""}${RESET}\n`)
printHeader()

const results = []
for (const c of cases) {
  results.push(await runCase(c))
}

// ─── summary ──────────────────────────────────────────────────────────────────
console.log("-".repeat(100))
const pass = results.filter((r) => r.ok && r.expected).length
const failMarker = results.filter((r) => !r.ok)
const failRoute = results.filter((r) => !r.expected)
console.log(`\n${BOLD}summary${RESET}: ${pass}/${results.length} passed`)
if (failMarker.length > 0) {
  console.log(`${RED}marker missed${RESET} (${failMarker.length}): ${failMarker.map((r) => r.name).join(", ")}`)
}
if (failRoute.length > 0) {
  console.log(`${RED}routing mismatch${RESET} (${failRoute.length}): ${failRoute.map((r) => r.name).join(", ")}`)
}

process.exit(pass === results.length ? 0 : 1)
