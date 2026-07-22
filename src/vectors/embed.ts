/**
 * vectors/embed.ts — generate embeddings.
 *
 * Two modes:
 *  - "api": use an OpenAI-compatible embeddings endpoint (via the active
 *    provider's embed() method).
 *  - "hash": a deterministic local hashing-based embedding. Zero API cost,
 *    no native deps, no model download. Lower semantic quality but always
 *    works offline and is good enough for keyword-ish semantic search.
 */
import type { KbConfig, LlmProvider } from "../types.js";

/** Deterministic hash-based embedding of fixed dimension. */
export function hashEmbed(text: string, dimensions: number): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const norm = new Array<number>(dimensions).fill(0);
  const lower = text.toLowerCase();
  // Tokenize on non-alphanumeric boundaries, keep tokens length >= 2.
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  for (const tok of tokens) {
    // Spread the token's hash across a few dimensions using rolling hashes.
    let h1 = 5381;
    let h2 = 0;
    for (let i = 0; i < tok.length; i++) {
      const c = tok.charCodeAt(i);
      h1 = ((h1 << 5) + h1 + c) | 0;
      h2 = (h2 * 16777619 + c) | 0;
    }
    const a = Math.abs(h1) % dimensions;
    const b = Math.abs(h2) % dimensions;
    vec[a] += 1;
    vec[b] += 0.5;
    norm[a] += 1;
    norm[b] += 1;
  }
  // L2 normalize so cosine similarity is meaningful.
  let mag = 0;
  for (let i = 0; i < dimensions; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dimensions; i++) vec[i] /= mag;
  return vec;
}

/** Generate an embedding using the configured mode + provider. */
export async function embedText(
  text: string,
  config: KbConfig,
  provider: LlmProvider | null,
): Promise<{ vector: number[]; mode: "api" | "hash" }> {
  if (config.embedding.mode === "api" && provider?.embed) {
    const v = await provider.embed(text);
    if (v && v.length > 0) return { vector: v, mode: "api" };
  }
  return {
    vector: hashEmbed(text, config.embedding.dimensions),
    mode: "hash",
  };
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}
