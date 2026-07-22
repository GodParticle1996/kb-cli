/**
 * providers/claude.ts — Anthropic Claude provider for extraction.
 * Uses ANTHROPIC_API_KEY. Cheap model (Haiku) by default for extraction.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";

export function createClaudeProvider(modelOverride?: string): LlmProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = modelOverride ?? "claude-3-5-haiku-20241022";
  const name: ProviderName = "anthropic";
  const available = Boolean(apiKey);

  let client: Anthropic | null = null;
  function getClient(): Anthropic {
    if (!client) client = new Anthropic({ apiKey: apiKey ?? undefined });
    return client;
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const c = getClient();
    const res = await c.messages.create({
      model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return {
      text,
      provider: name,
      model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  }

  return {
    name,
    label: `Anthropic Claude (${model})`,
    available,
    chat,
  };
}
