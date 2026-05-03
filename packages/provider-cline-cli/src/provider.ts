// ProviderV3 implementation. opencode (and any AI SDK consumer) calls
// `provider.languageModel(modelId)` to obtain a LanguageModelV3 instance.
//
// `embeddingModel` and `imageModel` throw — cline doesn't expose those
// modalities through its CLI.

import type { ProviderV3, EmbeddingModelV3, ImageModelV3 } from "@ai-sdk/provider"
import { ClineLanguageModel } from "./language-model.js"
import type { ClineProviderOptions } from "./types.js"

export interface ClineProvider extends ProviderV3 {
  /** Convenience callable: provider("default") === provider.languageModel("default"). */
  (modelId: string): ClineLanguageModel
}

export function createCline(options: ClineProviderOptions = {}): ClineProvider {
  const provider = ((modelId: string) => provider.languageModel(modelId)) as unknown as ClineProvider

  ;(provider as { specificationVersion: "v3" }).specificationVersion = "v3"

  provider.languageModel = (modelId: string) => new ClineLanguageModel(modelId, options)

  provider.embeddingModel = (_modelId: string): EmbeddingModelV3 => {
    throw new Error("cline provider does not support text embeddings")
  }

  // Deprecated alias kept for AI-SDK consumers that still call textEmbeddingModel.
  ;(provider as unknown as { textEmbeddingModel: (id: string) => EmbeddingModelV3 }).textEmbeddingModel =
    provider.embeddingModel

  provider.imageModel = (_modelId: string): ImageModelV3 => {
    throw new Error("cline provider does not support image generation")
  }

  return provider
}

/** Default instance with no options — uses `cline` from PATH, subprocess mode. */
export const cline: ClineProvider = createCline()
