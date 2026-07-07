// Public entry point.
//
// opencode loads providers via their `npm` field; the resolved package's default
// export must be a function/object that returns a ProviderV3-shaped object
// (Vercel AI SDK v3 — see provider.ts for the implementation).
// We expose both `createCline` (factory) and `cline` (default instance), and
// the default export is the factory for convenience.

export { createCline, cline } from "./provider.js"
export type { ClineProvider } from "./provider.js"
export { ClineLanguageModel } from "./language-model.js"
export type { ClineProviderOptions, ClineMode, CliFlavor, ClineEvent, RunResult } from "./types.js"
export { readGlobalState, defaultClineConfigPaths } from "./config-reader.js"
export type { ClineGlobalState, ClineConfigPaths } from "./config-reader.js"
export { runOnce, runStream } from "./cline-runner.js"
export { runOnceAcp, runStreamAcp } from "./cline-acp-runner.js"
export { runStreamJson } from "./stream-json-runner.js"
export {
  DEFAULT_CLINE_TURN_MAX_TURNS,
  DEFAULT_CLINE_TURN_TIMEOUT_MS,
  emptyClineUsage,
  runClineTurn,
  runClineTurnGenerate,
  runClineTurnOnce,
} from "./cline-turn-engine.js"
export type {
  ClineTurnConfig,
  ClineTurnEvent,
  ClineTurnRequest,
  ClineTurnResult,
  ClineTurnRunners,
} from "./cline-turn-engine.js"
export {
  openAiMessagesToPrompt,
  openAiToolsToProtocolTools,
  startOpenAiCompatServer,
} from "./openai-compat-server.js"
export type {
  OpenAiCompatModel,
  OpenAiCompatServerHandle,
  OpenAiCompatServerOptions,
} from "./openai-compat-server.js"
export {
  resolveCliRunProfile,
  deriveModelDef,
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_COMMAND,
} from "./cli-profiles.js"
export type { CliModelDef, CliRunProfile, CliLineParser, ParsedLine } from "./cli-profiles.js"

import { createCline } from "./provider.js"
export default createCline
