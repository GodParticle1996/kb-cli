/**
 * providers/openai-compat.ts — generic OpenAI-compatible provider.
 * Uses OPENAI_API_KEY + optional OPENAI_BASE_URL. Covers OpenAI itself, any
 * OpenAI-compatible endpoint (Groq via base URL, LM Studio, OpenRouter, etc.).
 * Also provides embeddings when the endpoint supports them.
 */
import OpenAI from "openai";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";
import { yieldStreamWithReasoning } from "./stream-utils.js";

export function createOpenAiCompatProvider(
  variant: "openai" | "openai-compat",
  modelOverride?: string,
  embeddingModel?: string,
): LlmProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = modelOverride ?? "gpt-4o-mini";
  const name: ProviderName = variant;
  // Treat as "openai" only when key is set. The "-compat" variant requires
  // a base URL too, since otherwise it's just plain OpenAI.
  const available =
    Boolean(apiKey) && (variant === "openai" || Boolean(baseURL));

  let client: OpenAI | null = null;
  function getClient(): OpenAI {
    if (!client) {
      client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL });
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

  async function embed(text: string): Promise<number[] | null> {
    try {
      const c = getClient();
      const res = await c.embeddings.create({
        model: embeddingModel ?? "text-embedding-3-small",
        input: text,
      });
      return res.data[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  return {
    name,
    label: baseURL ? `OpenAI-compatible (${baseURL}, ${model})` : `OpenAI (${model})`,
    available,
    chat,
    chatStream,
    embed,
  };
}
