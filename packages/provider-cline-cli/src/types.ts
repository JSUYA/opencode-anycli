// Shared types for @opencode-anycli/provider-cline-cli.

/**
 * How this provider invokes cline.
 *
 *  - "subprocess" (default) — `cline --json --yolo --act <prompt>`.
 *    Normally the prompt rides on argv, but Linux caps each arg at
 *    MAX_ARG_STRLEN = 32*PAGE_SIZE (128 KiB on 4 KiB pages) which long
 *    sessions used to trip with E2BIG. We now spill oversize prompts to a
 *    temp file and pass cline a short wrapper instructing it to read
 *    that path — the runner handles this automatically (see
 *    prompt-tempfile.ts), so any cline version is effectively unlimited.
 *
 *  - "acp" (opt-in) — `cline --acp` + Agent Client Protocol over stdio
 *    JSON-RPC. The prompt travels in the message body, no argv hop, no
 *    temp file. Use when you want the richer protocol surface (structured
 *    tool_call updates, plan / mode events, multi-turn sessions) — long
 *    prompts alone do NOT require this mode anymore.
 *
 *  - "passthrough" (planned) — bypass cline entirely and call the model
 *    directly using cline's stored credentials. NOT YET IMPLEMENTED.
 */
export type ClineMode = "subprocess" | "acp" | "passthrough"

export interface ClineProviderOptions {
  /** See {@link ClineMode}. Default: "subprocess". */
  mode?: ClineMode
  /** Path to the cline binary. Defaults to "cline" (resolved via PATH). */
  command?: string
  /** Extra args appended after `--json --yolo --act`. */
  extraArgs?: string[]
  /** Working directory for the spawned cline process. */
  cwd?: string
  /** How long to wait for cline to finish before killing it. Default 3_600_000 ms (1 hour). */
  timeoutMs?: number
  /** Environment variables to merge into the spawned process's env. */
  env?: Record<string, string>
}

/**
 * Subset of cline NDJSON event shapes we actively recognize.
 * `unknown` is fine for the rest — we skip those defensively.
 */
export type ClineEvent =
  | { type: "task_started"; taskId?: string; ts?: number }
  | { type: "say"; say: "text"; text?: string; partial?: boolean; ts?: number }
  | { type: "say"; say: "reasoning"; text?: string; reasoning?: string; partial?: boolean; ts?: number }
  | { type: "say"; say: "completion_result"; text?: string; partial?: boolean; ts?: number }
  | { type: "say"; say: string; text?: string; reasoning?: string; partial?: boolean; commandCompleted?: boolean; ts?: number }
  | { type: "ask"; ask: string; text?: string; partial?: boolean; ts?: number }
  | { type: "say"; say: "api_req_started"; text?: string; ts?: number }
  | {
      type: "say"
      say: "api_req_finished"
      text?: string
      tokensIn?: number
      tokensOut?: number
      cacheWrites?: number
      cacheReads?: number
      cost?: number
      ts?: number
    }
  | { type: string; [key: string]: unknown }

export interface ClineUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number | undefined
}

export interface RunResult {
  /** Final assistant text. */
  text: string
  /** Token counts harvested from cline events or persisted task state, if present. */
  usage: ClineUsage
  /** Number of NDJSON lines that failed to parse — useful for diagnostics. */
  parseErrors: number
}
