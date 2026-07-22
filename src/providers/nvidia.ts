/**
 * providers/nvidia.ts — NVIDIA NIM API provider.
 *
 * Uses NVIDIA_API_KEY to call the NVIDIA NIM OpenAI-compatible endpoint at
 * https://integrate.api.nvidia.com/v1. Supports reasoning_effort for
 * reasoning-capable models (e.g. z-ai/glm-5.2, deepseek-ai/deepseek-v4-pro).
 *
 * Available models via this endpoint:
 *   - z-ai/glm-5.2          (GLM 5.2 reasoning model)
 *   - deepseek-ai/deepseek-v4-pro  (DeepSeek V4 Pro reasoning model)
 *   - minimaxai/minimax-m3  (MiniMax M3 multimodal model)
 *
 * Default model: z-ai/glm-5.2
 */
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";
import { yieldStreamWithReasoning } from "./stream-utils.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export function createNvidiaProvider(modelOverride?: string): LlmProvider {
  const apiKey = process.env.NVIDIA_API_KEY;
  const model = modelOverride ?? "z-ai/glm-5.2";
  const name: ProviderName = "nvidia";
  const available = Boolean(apiKey);

  let client: OpenAI | null = null;
  function getClient(): OpenAI {
    if (!client) {
      client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: NVIDIA_BASE_URL });
    }
    return client;
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const c = getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (c.chat.completions as any).create({
      model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    });
    const text = res.choices[0]?.message?.content ?? "";
    return {
      text,
      provider: name,
      model,
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    };
  }

  async function* chatStream(req: ChatRequest): AsyncIterable<string> {
    const c = getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await (c.chat.completions as any).create({
      model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
      stream: true,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    });
    yield* yieldStreamWithReasoning(stream);
  }

  return {
    name,
    label: `NVIDIA NIM (${model})`,
    available,
    chat,
    chatStream,
  };
}
