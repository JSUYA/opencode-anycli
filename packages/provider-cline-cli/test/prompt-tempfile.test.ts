import { describe, it, expect, afterEach } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import {
  DEFAULT_ARGV_SAFE_LIMIT_BYTES,
  argvSafeLimitBytes,
  buildPromptFileWrapper,
  deletePromptTempFile,
  shouldUsePromptFile,
  writePromptTempFile,
} from "../src/prompt-tempfile.js"

describe("argvSafeLimitBytes", () => {
  const ENV_KEY = "OPENCODE_ANYCLI_ARGV_LIMIT"
  const original = process.env[ENV_KEY]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it("returns the default when env var is unset", () => {
    delete process.env[ENV_KEY]
    expect(argvSafeLimitBytes()).toBe(DEFAULT_ARGV_SAFE_LIMIT_BYTES)
  })

  it("honors a positive integer override", () => {
    process.env[ENV_KEY] = "1024"
    expect(argvSafeLimitBytes()).toBe(1024)
  })

  it("ignores non-numeric / non-positive values", () => {
    process.env[ENV_KEY] = "not-a-number"
    expect(argvSafeLimitBytes()).toBe(DEFAULT_ARGV_SAFE_LIMIT_BYTES)
    process.env[ENV_KEY] = "0"
    expect(argvSafeLimitBytes()).toBe(DEFAULT_ARGV_SAFE_LIMIT_BYTES)
    process.env[ENV_KEY] = "-100"
    expect(argvSafeLimitBytes()).toBe(DEFAULT_ARGV_SAFE_LIMIT_BYTES)
  })
})

describe("shouldUsePromptFile", () => {
  const ENV_KEY = "OPENCODE_ANYCLI_ARGV_LIMIT"
  const original = process.env[ENV_KEY]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
  })

  it("returns false for a small prompt", () => {
    expect(shouldUsePromptFile("hello world")).toBe(false)
  })

  it("returns true once the byte length exceeds the limit", () => {
    process.env[ENV_KEY] = "16"
    expect(shouldUsePromptFile("hi")).toBe(false) // 2 bytes
    expect(shouldUsePromptFile("x".repeat(17))).toBe(true) // 17 bytes
  })

  it("counts UTF-8 bytes, not characters", () => {
    process.env[ENV_KEY] = "10"
    // each Korean char is 3 UTF-8 bytes → 4 chars = 12 bytes > 10
    expect(shouldUsePromptFile("한글한글")).toBe(true)
    // 3 chars = 9 bytes <= 10
    expect(shouldUsePromptFile("한글한")).toBe(false)
  })
})

describe("writePromptTempFile / deletePromptTempFile", () => {
  it("writes the prompt verbatim and deletes it on demand", async () => {
    const content = "line one\nline two\n한글 포함\n"
    const path = await writePromptTempFile(content)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toBe(content)
    await deletePromptTempFile(path)
    expect(existsSync(path)).toBe(false)
  })

  it("produces unique paths across calls", async () => {
    const a = await writePromptTempFile("a")
    const b = await writePromptTempFile("b")
    expect(a).not.toBe(b)
    await deletePromptTempFile(a)
    await deletePromptTempFile(b)
  })

  it("deletePromptTempFile is idempotent (no throw on missing path)", async () => {
    await expect(deletePromptTempFile("/nonexistent/opencode-anycli-test")).resolves.toBeUndefined()
  })
})

describe("buildPromptFileWrapper", () => {
  it("includes the absolute path on its own line", () => {
    const out = buildPromptFileWrapper("/tmp/opencode-anycli-prompts/prompt-abc.txt")
    expect(out).toContain("/tmp/opencode-anycli-prompts/prompt-abc.txt")
  })

  it("instructs cline to use readFile and not echo the redirection", () => {
    const out = buildPromptFileWrapper("/tmp/x.txt")
    expect(out).toMatch(/readFile/i)
    expect(out).toMatch(/do not mention/i)
  })

  it("stays small (well under the argv limit)", () => {
    const out = buildPromptFileWrapper("/tmp/" + "x".repeat(200) + ".txt")
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(2048)
  })
})
