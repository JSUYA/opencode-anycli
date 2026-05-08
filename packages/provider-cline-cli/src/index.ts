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
export type { ClineProviderOptions, ClineMode, ClineEvent, RunResult } from "./types.js"
export { readGlobalState, defaultClineConfigPaths } from "./config-reader.js"
export type { ClineGlobalState, ClineConfigPaths } from "./config-reader.js"
export { runOnce, runStream } from "./cline-runner.js"
export { runOnceAcp, runStreamAcp } from "./cline-acp-runner.js"

import { createCline } from "./provider.js"
export default createCline
