/**
 * providers/index.ts — provider registry + auto-detection.
 *
 * Detection order (cheap/fast first):
 *   1. groq          (GROQ_API_KEY)
 *   2. gemini        (GEMINI_API_KEY / GOOGLE_API_KEY)  [via openai-compat]
 *   3. openai        (OPENAI_API_KEY, no base URL)
 *   4. openai-compat (OPENAI_API_KEY + OPENAI_BASE_URL)
 *   5. anthropic     (ANTHROPIC_API_KEY)
 *   6. cloudflare    (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
 *   7. nvidia        (NVIDIA_API_KEY)
 */
import type { KbConfig, LlmProvider, ProviderName } from "../types.js";
import { resolveProvider } from "../config.js";
import { createClaudeProvider } from "./claude.js";
import { createCloudflareProvider } from "./cloudflare.js";
import { createGeminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import { createNvidiaProvider } from "./nvidia.js";
import { createOpenAiCompatProvider } from "./openai-compat.js";

/** Build all known providers from the current environment + config. */
export function buildProviders(config: KbConfig): LlmProvider[] {
  return [
    createGroqProvider(config.models.groq),
    createGeminiProvider(config.models.gemini),
    // Plain OpenAI (no base URL override).
    createOpenAiCompatProvider("openai", config.models.openai, config.embedding.model),
    // A user-supplied OpenAI-compatible endpoint (OPENAI_API_KEY + OPENAI_BASE_URL).
    createOpenAiCompatProvider(
      "openai-compat",
      config.models["openai-compat"],
      config.embedding.model,
    ),
    createClaudeProvider(config.models.anthropic),
    createCloudflareProvider(config.models.cloudflare),
    createNvidiaProvider(config.models.nvidia),
  ];
}

/** Names of providers that are currently usable (key present). */
export function availableProviderNames(providers: LlmProvider[]): ProviderName[] {
  return providers.filter((p) => p.available).map((p) => p.name);
}

/**
 * Resolve the active provider per config. When config.provider === "auto",
 * picks the cheapest available provider. Returns null if none available.
 */
export function getProvider(
  config: KbConfig,
  providers?: LlmProvider[],
): { provider: LlmProvider | null; available: ProviderName[] } {
  const all = providers ?? buildProviders(config);
  const available = availableProviderNames(all);
  const chosen = resolveProvider(config, available);
  const provider = chosen ? all.find((p) => p.name === chosen) ?? null : null;
  return { provider, available };
}

/**
 * Find a provider that supports embeddings, preferring the active provider
 * and falling back to any OpenAI-compatible provider with a key.
 */
export function getEmbeddingProvider(
  config: KbConfig,
  providers?: LlmProvider[],
): LlmProvider | null {
  const all = providers ?? buildProviders(config);
  const { provider } = getProvider(config, all);
  if (provider?.embed) return provider;
  return all.find((p) => p.available && p.embed) ?? null;
}
