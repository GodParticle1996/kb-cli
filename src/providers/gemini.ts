/**
 * providers/gemini.ts — Google Gemini provider for extraction.
 *
 * Uses GEMINI_API_KEY (or GOOGLE_API_KEY) and Google's OpenAI-compatible
 * chat completions endpoint
 * (https://generativelanguage.googleapis.com/v1beta/openai/).
 * Default model: gemini-1.5-flash (cheap/fast, good for extraction).
 */
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function createGeminiProvider(modelOverride?: string): LlmProvider {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = modelOverride ?? "gemini-1.5-flash";
  const name: ProviderName = "gemini";
  const available = Boolean(apiKey);

  let client: OpenAI | null = null;
  function getClient(): OpenAI {
    if (!client) {
      client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: GEMINI_BASE_URL });
    }
    return client;
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const c = getClient();
    const res = await c.chat.completions.create({
      model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
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

  return {
    name,
    label: `Google Gemini (${model})`,
    available,
    chat,
  };
}
