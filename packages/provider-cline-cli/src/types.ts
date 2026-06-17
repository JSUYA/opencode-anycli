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

/**
 * Which locally-installed CLI this provider drives.
 *
 *  - "cline"  (default) — the cline CLI, via NDJSON subprocess or `--acp`.
 *  - "claude" — Claude Code CLI, via `claude -p --output-format stream-json`.
 *  - "codex"  — Codex CLI, via `codex exec --json`.
 *
 * claude / codex have no native `--acp` transport, so they always run in
 * subprocess stream-json mode. The model + reasoning effort come from the
 * opencode model id (see cli-profiles.ts), and yolo permission bypass is
 * applied automatically per CLI.
 */
export type CliFlavor = "cline" | "claude" | "codex"

export interface ClineProviderOptions {
  /** See {@link CliFlavor}. Default: "cline". */
  cli?: CliFlavor
  /** See {@link ClineMode}. Default: "subprocess". */
  mode?: ClineMode
  /** Path to the CLI binary. Defaults to the flavor name (`cline`/`claude`/`codex`), resolved via PATH. */
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
 *
 * Cline has TWO event schemas in active use (verified against cline 2.18):
 *
 *   Legacy (--yolo --act path):
 *     task_started → say.task → say.api_req_started (text JSON carries
 *     tokensIn/tokensOut/cacheReads/cacheWrites/cost) → say.completion_result
 *
 *   Current (default / plan / non-yolo path):
 *     hook_event(agent_start, taskId) →
 *     agent_event(iteration_start) →
 *     agent_event(content_start, text deltas) →
 *     agent_event(usage, inputTokens/outputTokens/...) →
 *     agent_event(content_end, full text) →
 *     agent_event(iteration_end) →
 *     hook_event(agent_end) →
 *     agent_event(done, usage) →
 *     run_result(usage, aggregateUsage, model, text)
 *
 * `ts` is a Unix-ms number in the legacy schema and an ISO-string in the
 * current schema. The runner normalizes both.
 */
export type ClineEvent =
  | { type: "task_started"; taskId?: string; ts?: number | string }
  | { type: "say"; say: "text"; text?: string; partial?: boolean; ts?: number | string }
  | { type: "say"; say: "reasoning"; text?: string; reasoning?: string; partial?: boolean; ts?: number | string }
  | { type: "say"; say: "completion_result"; text?: string; partial?: boolean; ts?: number | string }
  | {
      type: "say"
      say: string
      text?: string
      reasoning?: string
      partial?: boolean
      commandCompleted?: boolean
      ts?: number | string
    }
  | { type: "ask"; ask: string; text?: string; partial?: boolean; ts?: number | string }
  | { type: "say"; say: "api_req_started"; text?: string; ts?: number | string }
  | {
      type: "say"
      say: "api_req_finished"
      text?: string
      tokensIn?: number
      tokensOut?: number
      cacheWrites?: number
      cacheReads?: number
      cost?: number
      ts?: number | string
    }
  | {
      type: "hook_event"
      hookEventName?: string
      agentId?: string
      taskId?: string
      parentAgentId?: string | null
      ts?: number | string
    }
  | { type: "agent_event"; event?: AgentEventBody; ts?: number | string }
  | {
      type: "run_result"
      finishReason?: string
      iterations?: number
      usage?: AgentUsagePayload
      aggregateUsage?: AgentUsagePayload
      durationMs?: number
      text?: string
      model?: unknown
      ts?: number | string
    }
  | { type: "error"; message?: string; ts?: number | string }
  | { type: string; [key: string]: unknown }

/**
 * Token payload shape used by cline's current schema. Every variant we've
 * observed populates `inputTokens` / `outputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens`; the cumulative `total*` fields only appear on
 * `agent_event.event.type === "usage"` interim snapshots; `totalCost`
 * appears on the terminal `done` / `run_result` payloads, while interim
 * snapshots use `cost`.
 */
export interface AgentUsagePayload {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  cost?: number
  totalCost?: number
}

export type AgentEventBody =
  | { type: "iteration_start"; iteration?: number }
  | { type: "iteration_end"; iteration?: number; hadToolCalls?: boolean; toolCallCount?: number }
  | { type: "content_start"; contentType?: string; text?: string }
  | { type: "content_end"; contentType?: string; text?: string }
  | ({ type: "usage" } & AgentUsagePayload)
  | { type: "error"; error?: { name?: string; message?: string; stack?: string }; recoverable?: boolean; iteration?: number }
  | { type: "done"; reason?: string; text?: string; iterations?: number; usage?: AgentUsagePayload }
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
  /**
   * Context-window size cline reported in the "X / Y tokens used" banner
   * during this run, if observed. Lets the language-model layer expose
   * the real upstream limit via providerMetadata so wrappers can render
   * an accurate `%` even when the static config disagrees with cline's
   * actual model.
   */
  contextMax?: number
}
