/**
 * providers/groq.ts — Groq provider for fast/cheap extraction.
 * Uses GROQ_API_KEY. Default model: llama-3.3-70b-versatile.
 */
import Groq from "groq-sdk";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";
import { yieldStreamWithReasoning } from "./stream-utils.js";

export function createGroqProvider(modelOverride?: string): LlmProvider {
  const apiKey = process.env.GROQ_API_KEY;
  const model = modelOverride ?? "llama-3.3-70b-versatile";
  const name: ProviderName = "groq";
  const available = Boolean(apiKey);

  let client: Groq | null = null;
  function getClient(): Groq {
    if (!client) client = new Groq({ apiKey: apiKey ?? undefined });
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
    const choice = res.choices[0];
    const text = choice?.message?.content ?? "";
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
    });
    yield* yieldStreamWithReasoning(stream);
  }

  return {
    name,
    label: `Groq (${model})`,
    available,
    chat,
    chatStream,
  };
}
