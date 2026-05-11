// Spillover for prompts that exceed argv's per-arg byte limit.
//
// cline's `--act <prompt>` carries the entire flattened conversation as a
// single argv token. Linux caps each arg at MAX_ARG_STRLEN = 32 * PAGE_SIZE
// (128 KiB on 4 KiB pages), independent of the larger ARG_MAX total — so
// long sessions / large pasted file context trip E2BIG at execve time. macOS
// is bounded by ARG_MAX itself (256 KiB–1 MiB depending on version). Either
// way, large prompts can't go through argv.
//
// This module spills oversize prompts to a temp file and produces a small
// wrapper text that instructs cline to read the file as the user request.
// Works on every cline version because we still go through the standard
// `--act` path; the heavy payload just moves from argv to disk.
//
// Threshold tunable via OPENCODE_ANYCLI_ARGV_LIMIT (bytes, UTF-8). Default
// 96 KiB leaves ~32 KiB headroom under the 128 KiB Linux per-arg cap for
// the rest of argv, envp pressure, and OS overhead.

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const DEFAULT_ARGV_SAFE_LIMIT_BYTES = 96 * 1024

/**
 * Resolve the byte limit at which we spill to a temp file. Reads the
 * `OPENCODE_ANYCLI_ARGV_LIMIT` env var (positive integer; bytes) once per
 * call so tests can mutate process.env without import-time freezing.
 */
export function argvSafeLimitBytes(): number {
  const env = process.env["OPENCODE_ANYCLI_ARGV_LIMIT"]
  if (env !== undefined) {
    const n = Number.parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_ARGV_SAFE_LIMIT_BYTES
}

/** True when `prompt` (UTF-8 byte length) exceeds the configured spill threshold. */
export function shouldUsePromptFile(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") > argvSafeLimitBytes()
}

/**
 * Write `prompt` to a unique file under `${tmpdir}/opencode-anycli-prompts/`
 * with mode 0o600. Creates the directory on demand. Returns the absolute path.
 */
export async function writePromptTempFile(prompt: string): Promise<string> {
  const dir = join(tmpdir(), "opencode-anycli-prompts")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `prompt-${randomUUID()}.txt`)
  await writeFile(file, prompt, { mode: 0o600, encoding: "utf8" })
  return file
}

/** Best-effort unlink — swallows ENOENT and other races. */
export async function deletePromptTempFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* ignore */
  }
}

/**
 * Wrapper text we send via argv when the real prompt was spilled to a file.
 * Designed to be short and generic for older cline builds: ask it to read
 * the exact absolute path, treat the file's contents as the user request,
 * and avoid echoing transport details back to the user.
 */
export function buildPromptFileWrapper(absPath: string): string {
  return [
    "Read this file, then follow its contents as the complete user request:",
    `  ${absPath}`,
    "",
    "Do not mention this handoff or the file path.",
  ].join("\n")
}
