// Shared types for @opencode-anycli/provider-cline-cli.

export type ClineMode = "subprocess" | "passthrough"

export interface ClineProviderOptions {
  /**
   * Which strategy the provider uses to call the LLM.
   * - "subprocess" (default): spawn the cline CLI and parse its NDJSON stream.
   * - "passthrough": read cline's config and call the underlying LLM directly. NOT YET IMPLEMENTED.
   */
  mode?: ClineMode
  /** Path to the cline binary. Defaults to "cline" (resolved via PATH). */
  command?: string
  /** Extra args appended after `--json --yolo --act`. */
  extraArgs?: string[]
  /** Working directory for the spawned cline process. */
  cwd?: string
  /** How long to wait for cline to finish before killing it. Default 600_000 ms (10 min). */
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
