/**
 * config.ts — loads and persists the global ~/.kb/config.json, merged with
 * optional per-project overrides in ./kb/.kbconfig.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KbConfig, ProjectConfig, ProviderName } from "./types.js";
import { configFile, ensureParent, projectConfigFile } from "./storage.js";

export const DEFAULT_CONFIG: KbConfig = {
  provider: "auto",
  models: {
    anthropic: "claude-3-5-haiku-20241022",
    groq: "llama-3.3-70b-versatile",
    openai: "gpt-4o-mini",
    "openai-compat": "gpt-4o-mini",
    gemini: "gemini-1.5-flash",
    cloudflare: "@cf/zai-org/glm-5.2",
    nvidia: "minimaxai/minimax-m3",
  },
  embedding: {
    // "hash" works with no API key; users can switch to "api" with an embeddings key.
    mode: "hash",
    model: "text-embedding-3-small",
    dimensions: 256,
  },
  autoCommit: true,
  chunkSize: 12000,
  reasoningEffort: "high",
  destinations: { project: true, global: true },
  watch: {
    providers: ["auto"],
    pollIntervalMs: 5000,
  },
};

export function loadConfig(): KbConfig {
  const file = configFile();
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<KbConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Load the project-level overrides merged on top of the global config. */
export function loadEffectiveConfig(cwd: string = process.cwd()): KbConfig {
  const base = loadConfig();
  const projFile = projectConfigFile(cwd);
  if (!existsSync(projFile)) return base;
  try {
    const proj = JSON.parse(readFileSync(projFile, "utf8")) as ProjectConfig;
    return mergeConfig(base, proj);
  } catch {
    return base;
  }
}

export function saveConfig(config: KbConfig): void {
  const file = configFile();
  ensureParent(file);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function mergeConfig(base: KbConfig, override: Partial<KbConfig>): KbConfig {
  return {
    ...base,
    ...override,
    models: { ...base.models, ...(override.models ?? {}) },
    embedding: { ...base.embedding, ...(override.embedding ?? {}) },
    destinations: {
      project: override.destinations?.project ?? base.destinations?.project ?? true,
      global: override.destinations?.global ?? base.destinations?.global ?? true,
    },
    watch: { ...base.watch, ...(override.watch ?? {}) },
  };
}

/** Resolve the concrete provider when config says "auto". */
export function resolveProvider(
  config: KbConfig,
  available: ProviderName[],
): ProviderName | null {
  if (config.provider !== "auto") {
    return available.includes(config.provider) ? config.provider : null;
  }
  // Preference order: cheap/fast first, then fallbacks.
  const order: ProviderName[] = [
    "groq",
    "gemini",
    "openai",
    "openai-compat",
    "anthropic",
    "cloudflare",
    "nvidia",
  ];
  for (const p of order) {
    if (available.includes(p)) return p;
  }
  return null;
}
