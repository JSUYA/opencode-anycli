import { describe, it, expect, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { existsSync, readFileSync } from "node:fs"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { runOnce } from "../src/cline-runner.js"

interface FakeProc extends EventEmitter {
  stdout: Readable
  stderr: Readable
  pid: number
  killed: boolean
  kill: (sig?: NodeJS.Signals | number) => boolean
}

function makeFakeProc(stdoutLines: string[]): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 4242
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    return true
  }
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  setTimeout(() => {
    for (const line of stdoutLines) proc.stdout.push(line + "\n")
    proc.stdout.push(null)
    proc.stderr.push(null)
    setTimeout(() => proc.emit("close", 0, null), 5)
  }, 0)
  return proc
}

/** Spawn fake that captures args + options so we can assert on them. */
function capturingSpawn(stdoutLines: string[]) {
  const captured: { args: readonly string[] | null } = { args: null }
  const fn = ((_cmd: string, args?: readonly string[], _options?: object) => {
    captured.args = args ?? null
    return makeFakeProc(stdoutLines) as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import("node:child_process").spawn
  return { fn, captured }
}

const COMPLETION = '{"type":"say","say":"completion_result","text":"done","partial":false}'
const ENV_KEY = "OPENCODE_ANYCLI_ARGV_LIMIT"

describe("cline-runner prompt spill", () => {
  const original = process.env[ENV_KEY]
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it("passes a small prompt verbatim through argv (no temp file)", async () => {
    delete process.env[ENV_KEY]
    const cap = capturingSpawn([COMPLETION])
    await runOnce({
      prompt: "small prompt",
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: cap.fn,
    })
    expect(cap.captured.args).not.toBeNull()
    const args = Array.from(cap.captured.args!)
    // argv shape: [--json, --yolo, --act, "<prompt>"]
    expect(args).toContain("small prompt")
    expect(args.some((a) => a.includes("complete user request"))).toBe(false)
  })

  it("passes the selected cline model with -m", async () => {
    delete process.env[ENV_KEY]
    const cap = capturingSpawn([COMPLETION])
    await runOnce({
      prompt: "small prompt",
      options: { command: "cline", timeoutMs: 5000, model: "GaussO4.1" },
      spawnFn: cap.fn,
    })

    expect(cap.captured.args).not.toBeNull()
    const args = Array.from(cap.captured.args!)
    expect(args).toEqual(["--json", "--yolo", "-m", "GaussO4.1", "--act", "small prompt"])
  })

  it("spills oversize prompt to a temp file and substitutes a wrapper in argv", async () => {
    process.env[ENV_KEY] = "32" // tiny limit so we trigger spill on a short string
    const big = "this prompt is intentionally larger than thirty two bytes so we spill"
    const cap = capturingSpawn([COMPLETION])
    await runOnce({
      prompt: big,
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: cap.fn,
    })
    expect(cap.captured.args).not.toBeNull()
    const args = Array.from(cap.captured.args!)
    // argv must NOT contain the original prompt anymore.
    expect(args).not.toContain(big)
    // argv must contain the wrapper signature.
    const wrapperArg = args.find((a) => a.includes("complete user request"))
    expect(wrapperArg).toBeDefined()
    // wrapper must reference a file path under our temp dir.
    const match = wrapperArg!.match(/(\S*opencode-anycli-prompts\/prompt-[^\s]+\.txt)/)
    expect(match).not.toBeNull()
    const filePath = match![1]
    // cleanup is scheduled from the child close path; give unlink a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(filePath)).toBe(false)
  })

  it("wrapper file contains the original prompt verbatim while cline runs", async () => {
    process.env[ENV_KEY] = "32"
    const big = "ABCDEFGHIJKLMNOPQRSTUVWXYZ-original-prompt-content-한글포함-XYZ"
    let captureMidRun: { exists: boolean; content: string | null } | null = null

    // Custom fake proc: read the temp file from argv DURING the run, BEFORE
    // the close event fires (which is when cleanup happens).
    const stdoutLines = [COMPLETION]
    const fn = ((_cmd: string, args?: readonly string[], _options?: object) => {
      const proc = new EventEmitter() as FakeProc
      proc.pid = 1
      proc.killed = false
      proc.kill = () => true
      proc.stdout = new Readable({ read() {} })
      proc.stderr = new Readable({ read() {} })

      setTimeout(() => {
        // Inspect temp file BEFORE we emit close — that's the window where
        // cline would actually be reading it.
        const wrapper = (args ?? []).find((a) => a.includes("complete user request"))
        const m = wrapper?.match(/(\S*opencode-anycli-prompts\/prompt-[^\s]+\.txt)/)
        if (m) {
          const path = m[1]!
          captureMidRun = {
            exists: existsSync(path),
            content: existsSync(path) ? readFileSync(path, "utf8") : null,
          }
        }
        for (const line of stdoutLines) proc.stdout.push(line + "\n")
        proc.stdout.push(null)
        proc.stderr.push(null)
        setTimeout(() => proc.emit("close", 0, null), 5)
      }, 0)
      return proc as unknown as ChildProcessWithoutNullStreams
    }) as unknown as typeof import("node:child_process").spawn

    await runOnce({
      prompt: big,
      options: { command: "cline", timeoutMs: 5000 },
      spawnFn: fn,
    })

    expect(captureMidRun).not.toBeNull()
    expect(captureMidRun!.exists).toBe(true)
    expect(captureMidRun!.content).toBe(big)
  })

  // ─── Case matrix: diverse dummy prompts ────────────────────────────────────
  // Verifies routing decisions and (for spilled cases) byte-for-byte content
  // preservation across size, encoding, and special-character variations.

  type Case = {
    name: string
    /** Construct the prompt — closures so we don't materialize huge strings until needed. */
    build: () => string
    /** Threshold at run time (bytes); kept generous to keep tests fast. */
    limit: number
    /** Whether routing should spill to a temp file. */
    expectSpill: boolean
  }

  const KB = 1024
  const cases: ReadonlyArray<Case> = [
    // ── argv path (under threshold) ────────────────────────────────
    {
      name: "ascii tiny (10 bytes)",
      build: () => "0123456789",
      limit: 96 * KB,
      expectSpill: false,
    },
    {
      name: "ascii medium (8 KB)",
      build: () => "x".repeat(8 * KB),
      limit: 96 * KB,
      expectSpill: false,
    },
    {
      name: "ascii near-threshold (95 KB) under default 96 KB",
      build: () => "x".repeat(95 * KB),
      limit: 96 * KB,
      expectSpill: false,
    },
    {
      name: "korean 5K chars under custom 20 KB limit (15 KB UTF-8)",
      build: () => "한".repeat(5_000), // 3 bytes × 5_000 = 15_000 bytes
      limit: 20 * KB,
      expectSpill: false,
    },
    {
      name: "mixed ASCII+Korean+emoji small",
      build: () => "Hello 안녕하세요 🚀".repeat(100),
      limit: 96 * KB,
      expectSpill: false,
    },
    {
      name: "exactly at limit (no spill — strict greater-than)",
      // build to exactly limit bytes
      build: () => "y".repeat(20 * KB),
      limit: 20 * KB,
      expectSpill: false,
    },

    // ── temp file path (over threshold) ────────────────────────────
    {
      name: "1 byte over limit",
      build: () => "z".repeat(20 * KB + 1),
      limit: 20 * KB,
      expectSpill: true,
    },
    {
      name: "100 KB ASCII (would E2BIG without fix)",
      build: () => "a".repeat(100 * KB),
      limit: 96 * KB,
      expectSpill: true,
    },
    {
      name: "200 KB ASCII",
      build: () => "b".repeat(200 * KB),
      limit: 96 * KB,
      expectSpill: true,
    },
    {
      name: "korean exceeds (50K chars ≈ 150 KB UTF-8)",
      build: () => "글".repeat(50_000),
      limit: 96 * KB,
      expectSpill: true,
    },
    {
      name: "code-dump-like content with newlines/tabs",
      build: () => {
        const block = "function foo(x) {\n\treturn x * 2\n}\n\n"
        return block.repeat(4_000) // ~140 KB
      },
      limit: 96 * KB,
      expectSpill: true,
    },
    {
      name: "special chars: control + emoji + null-ish (\\x01)",
      build: () => `\t\n— 한글 — 🚀\n`.repeat(8_000), // ~280 KB UTF-8
      limit: 96 * KB,
      expectSpill: true,
    },
    {
      name: "huge (1 MB)",
      build: () => "Q".repeat(1024 * KB),
      limit: 96 * KB,
      expectSpill: true,
    },
  ]

  for (const c of cases) {
    it(`case: ${c.name}`, async () => {
      process.env[ENV_KEY] = String(c.limit)
      const prompt = c.build()
      const promptBytes = Buffer.byteLength(prompt, "utf8")

      let observedPath: string | null = null
      let observedContent: string | null = null
      let observedDuringRun: boolean | null = null

      // Custom spawn fake: snapshot temp file existence + content DURING run,
      // then emit close so cleanup runs.
      const fn = ((_cmd: string, args?: readonly string[], _options?: object) => {
        const proc = new EventEmitter() as FakeProc
        proc.pid = 9000
        proc.killed = false
        proc.kill = () => true
        proc.stdout = new Readable({ read() {} })
        proc.stderr = new Readable({ read() {} })

        setTimeout(() => {
          const argList = Array.from(args ?? [])
          const wrapper = argList.find((a) => a.includes("complete user request"))
          if (wrapper) {
            const m = wrapper.match(/(\S*opencode-anycli-prompts\/prompt-[^\s]+\.txt)/)
            if (m) {
              observedPath = m[1]!
              observedDuringRun = existsSync(observedPath)
              if (observedDuringRun) observedContent = readFileSync(observedPath, "utf8")
            }
          }
          proc.stdout.push(COMPLETION + "\n")
          proc.stdout.push(null)
          proc.stderr.push(null)
          setTimeout(() => proc.emit("close", 0, null), 5)
        }, 0)
        return proc as unknown as ChildProcessWithoutNullStreams
      }) as unknown as typeof import("node:child_process").spawn

      // Capture argv shape too.
      const cap = capturingSpawn([COMPLETION])
      // Compose: capturing then real timing — use inner fn so we get both.
      // (Simpler: capture from `fn` itself.)
      const captured: { args: readonly string[] | null } = { args: null }
      const wrappedFn = ((cmd: string, args?: readonly string[], options?: object) => {
        captured.args = args ?? null
        return (fn as unknown as (
          c: string,
          a?: readonly string[],
          o?: object,
        ) => ChildProcessWithoutNullStreams)(cmd, args, options)
      }) as unknown as typeof import("node:child_process").spawn
      void cap

      await runOnce({
        prompt,
        options: { command: "cline", timeoutMs: 30_000 },
        spawnFn: wrappedFn,
      })

      const argList = Array.from(captured.args ?? [])
      const wrapperArg = argList.find((a) => a.includes("complete user request"))

      if (c.expectSpill) {
        expect(wrapperArg, `expected spill (${promptBytes} bytes > ${c.limit})`).toBeDefined()
        // argv must NOT carry the original prompt
        expect(argList).not.toContain(prompt)
        // temp file existed during the run, has identical content
        expect(observedDuringRun).toBe(true)
        expect(observedContent).toBe(prompt)
        // temp file is cleaned up after close (give the async unlink a tick)
        expect(observedPath).not.toBeNull()
        await new Promise((r) => setTimeout(r, 30))
        expect(existsSync(observedPath!)).toBe(false)
      } else {
        expect(wrapperArg, `expected no spill (${promptBytes} bytes <= ${c.limit})`).toBeUndefined()
        expect(argList).toContain(prompt)
        expect(observedPath).toBeNull()
      }
    })
  }

  it("cleans up the temp file when the subprocess errors out", async () => {
    process.env[ENV_KEY] = "32"
    const big = "x".repeat(100)
    let capturedPath: string | null = null

    const fn = ((_cmd: string, args?: readonly string[], _options?: object) => {
      const proc = new EventEmitter() as FakeProc
      proc.pid = 2
      proc.killed = false
      proc.kill = () => true
      proc.stdout = new Readable({ read() {} })
      proc.stderr = new Readable({ read() {} })
      const wrapper = (args ?? []).find((a) => a.includes("complete user request"))
      const m = wrapper?.match(/(\S*opencode-anycli-prompts\/prompt-[^\s]+\.txt)/)
      if (m) capturedPath = m[1]!
      setTimeout(() => {
        proc.emit("error", new Error("synthetic spawn failure"))
      }, 0)
      return proc as unknown as ChildProcessWithoutNullStreams
    }) as unknown as typeof import("node:child_process").spawn

    await expect(
      runOnce({ prompt: big, options: { command: "cline", timeoutMs: 5000 }, spawnFn: fn }),
    ).rejects.toThrow(/synthetic spawn failure/)

    expect(capturedPath).not.toBeNull()
    // give the unlink a microtask to complete
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(capturedPath!)).toBe(false)
  })
})
