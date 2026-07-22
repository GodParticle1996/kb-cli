/**
 * Shared types for the kb Central Memory CLI.
 */

export type Scope = "project" | "global";

/** AI coding tool whose sessions kb watches. */
export type SourceTool = "claude" | "kimi" | "opencode" | "codex" | "cline" | "unattributed";

export type ProviderName =
  | "anthropic"
  | "groq"
  | "openai"
  | "openai-compat"
  | "gemini"
  | "cloudflare"
  | "nvidia";

/** Category of an extracted piece of knowledge. */
export type FactCategory =
  | "decision"
  | "architecture"
  | "pattern"
  | "bugfix"
  | "file-change"
  | "state"
  | "open-question"
  | "note";

/** A single extracted fact, ready to be merged into the wiki. */
export interface ExtractedFact {
  id: string;
  /** Human-readable summary, e.g. "Use Redis for session caching". */
  content: string;
  category: FactCategory;
  /** Optional rationale or supporting detail. */
  rationale?: string;
  /** Which wiki file this fact should land in (relative to wiki root). */
  wikiFile?: string;
  /** Source session label, e.g. "2025-07-05-auth-refactor". */
  source: string;
  /** Tool that produced the session (claude|kimi|opencode|codex|cline). */
  tool?: SourceTool;
  /** Task slug this fact belongs to (joins wiki/tasks/<slug>.md). */
  task?: string;
  /** ISO timestamp of extraction. */
  timestamp: string;
}

/** Result of running the extraction pipeline. */
export interface CaptureResult {
  scope: Scope;
  sessionId: string;
  factsExtracted: number;
  filesWritten: string[];
  contradictions: string[];
  embeddings: number;
  committed: boolean;
  /** Summary message for the CLI. */
  summary: string;
}

/** Provider-agnostic chat completion request. */
export interface ChatRequest {
  system: string;
  user: string;
  /** Max output tokens for the extraction model. */
  maxTokens?: number;
  /** Optional temperature; defaults low for extraction. */
  temperature?: number;
  /** Reasoning depth for reasoning models ("low" | "medium" | "high").
   *  Forwarded as-is to the provider; ignored by non-reasoning models. */
  reasoningEffort?: "low" | "medium" | "high";
}

/** Provider-agnostic chat completion response. */
export interface ChatResponse {
  text: string;
  provider: ProviderName;
  model: string;
  /** Approximate input tokens, if reported by the provider. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Provider abstraction used for extraction + (optionally) embeddings. */
export interface LlmProvider {
  name: ProviderName;
  /** Human-readable label for status output. */
  label: string;
  /** Whether this provider is currently usable (key present). */
  available: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Stream tokens one-by-one. Optional; not required for Central Memory. */
  chatStream?(req: ChatRequest): AsyncIterable<string>;
  /** Generate an embedding vector. May be unsupported (returns null). */
  embed?(text: string): Promise<number[] | null>;
}

/** Top-level ~/.kb/config.json schema. */
export interface KbConfig {
  /** Active extraction provider, or "auto" to auto-detect. */
  provider: ProviderName | "auto";
  /** Model override per provider. */
  models: Partial<Record<ProviderName, string>>;
  /** Embedding configuration. */
  embedding: EmbeddingConfig;
  /** Whether to auto git-commit the wiki after capture. */
  autoCommit: boolean;
  /** Max chars per chunk fed to the extraction model. */
  chunkSize: number;
  /** Watch-mode settings. */
  watch: WatchConfig;
  /** Reasoning depth for the extractor (understand.ts).
   *  Forwarded to reasoning models; ignored by non-reasoning models. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Whether captures also write to ./kb/ (project) and/or the per-tool global KB. */
  destinations: { project: boolean; global: boolean };
}

export interface EmbeddingConfig {
  /** "api" (OpenAI-compatible embeddings endpoint) or "hash" (local fallback). */
  mode: "api" | "hash";
  /** Model name for API embeddings. */
  model: string;
  /** Vector dimensionality for the hash fallback (must match table schema). */
  dimensions: number;
}

export interface WatchConfig {
  /** Tools to watch: "claude", "cline", "kimi", "opencode", "codex".
   *  Empty / ["auto"] means auto-detect every installed tool. */
  providers: string[];
  /** Poll interval in ms for daemon health checks. */
  pollIntervalMs: number;
}

/** Project-level ~/.kbconfig.json overrides (subset of KbConfig). */
export type ProjectConfig = Partial<
  Pick<KbConfig, "provider" | "models" | "embedding" | "autoCommit" | "chunkSize" | "reasoningEffort" | "destinations">
>;

/** A row stored in the LanceDB vectors table. */
export interface VectorRow {
  id: string;
  vector: number[];
  text: string;
  category: FactCategory;
  wikiFile: string;
  source: string;
  /** Tag the row with the tool that produced it. */
  tool?: SourceTool;
  timestamp: string;
  scope: Scope;
}
