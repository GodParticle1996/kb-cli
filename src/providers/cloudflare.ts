/**
 * providers/cloudflare.ts — Cloudflare Workers AI provider for extraction.
 *
 * Uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to call the Workers AI
 * REST API at https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}.
 *
 * The Workers AI API is NOT OpenAI-compatible: it uses a custom request/response
 * format over plain REST, so it needs its own provider implementation.
 *
 * Default model: @cf/zai-org/glm-5.2 (GLM 5.2)
 * Also supports: @cf/moonshotai/kimi-k2.7-code, @cf/meta/llama-3.1-8b-instruct, etc.
 */
import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../types.js";

const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";

export function createCloudflareProvider(modelOverride?: string): LlmProvider {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const model = modelOverride ?? "@cf/zai-org/glm-5.2";
  const name: ProviderName = "cloudflare";
  const available = Boolean(apiToken && accountId);

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    if (!apiToken || !accountId) {
      throw new Error("Cloudflare provider unavailable: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
    }
    // Cloudflare Workers AI expects the raw model name in the URL path
    // (including @ and / characters) — do NOT URL-encode it.
    const url = `${CF_BASE}/${accountId}/ai/run/${model}`;
    const body: Record<string, unknown> = {
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Cloudflare Workers AI error ${res.status}: ${errText.slice(0, 300)}`,
      );
    }

    const json: Record<string, unknown> = await res.json() as Record<string, unknown>;
    const result = json.result as Record<string, unknown> | undefined;
    // Cloudflare Workers AI chat API returns OpenAI-compatible format:
    // { result: { choices: [{ message: { content: "..." } }], usage: {...} } }
    // Some models (GLM 5.2) also return reasoning_content in the message.
    const choices = result?.choices as Array<{ message?: { content?: string } }> | undefined;
    const text = choices?.[0]?.message?.content ?? "";
    const usage = result?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

    return {
      text,
      provider: name,
      model,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    };
  }

  return {
    name,
    label: `Cloudflare Workers AI (${model})`,
    available,
    chat,
  };
}
