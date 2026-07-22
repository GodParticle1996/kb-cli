/**
 * extractor/llm-extract.ts — runs extraction against a provider and parses
 * the JSON response into ExtractedFact[]. Includes a heuristic fallback that
 * produces lower-quality facts when no LLM provider is configured.
 */
import { createHash } from "node:crypto";
import type {
  ChatRequest,
  ExtractedFact,
  FactCategory,
  LlmProvider,
  SourceTool,
} from "../types.js";
import { EXTRACTION_SYSTEM, extractionUserPrompt } from "./prompts.js";
import type { ExtractionJsonFact } from "./prompts.js";

const VALID_CATEGORIES: FactCategory[] = [
  "decision",
  "architecture",
  "pattern",
  "bugfix",
  "file-change",
  "state",
  "open-question",
  "note",
];

function coerceCategory(s: string): FactCategory {
  const lower = s.toLowerCase().trim();
  return (VALID_CATEGORIES as string[]).includes(lower)
    ? (lower as FactCategory)
    : "note";
}

/** Tolerantly parse a JSON array out of an LLM response (handles fences, prose). */
export function parseJsonFacts(raw: string): ExtractionJsonFact[] {
  if (!raw) return [];
  let s = raw.trim();
  // Strip markdown code fences if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Find the first '[' ... matching ']' span as a fallback.
  if (!s.startsWith("[")) {
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.content === "string");
  } catch {
    return [];
  }
}

/**
 * Stable, content-derived fact id. Re-capturing the same logical fact (e.g. the
 * watcher reprocessing a growing session file) yields the same id, so the vector
 * store can dedupe/upsert instead of accumulating duplicates.
 */
function makeFactId(content: string, tool: string, category: string): string {
  const h = createHash("sha1")
    .update(`${tool}|${category}|${content.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, 20);
  return `fact-${h}`;
}

/** Convert raw JSON facts into ExtractedFact with metadata. */
export function toExtractedFacts(
  jsonFacts: ExtractionJsonFact[],
  source: string,
  timestamp: string,
  tool: SourceTool = "unattributed",
  task?: string,
): ExtractedFact[] {
  return jsonFacts.map((jf) => {
    const category = coerceCategory(jf.category);
    return {
      id: makeFactId(jf.content, tool, category),
      content: jf.content.trim().slice(0, 240),
      category,
      rationale: jf.rationale?.trim() || undefined,
      source,
      tool,
      task,
      timestamp,
    };
  });
}

export interface ExtractOptions {
  provider: LlmProvider | null;
  sessionLabel: string;
  timestamp: string;
  tool: SourceTool;
  task?: string;
  maxTokens?: number;
}

/** Run LLM extraction on a single chunk. Returns ExtractedFact[]. */
export async function extractFromChunk(
  chunkText: string,
  chunkIndex: number,
  opts: ExtractOptions,
): Promise<{ facts: ExtractedFact[]; usedHeuristic: boolean }> {
  if (!opts.provider) {
    return {
      facts: heuristicExtract(chunkText, opts.sessionLabel, opts.timestamp, opts.tool, opts.task),
      usedHeuristic: true,
    };
  }

  const req: ChatRequest = {
    system: EXTRACTION_SYSTEM,
    user: extractionUserPrompt(opts.sessionLabel, chunkText),
    maxTokens: opts.maxTokens ?? 2048,
    temperature: 0.2,
  };

  try {
    const res = await opts.provider.chat(req);
    const jsonFacts = parseJsonFacts(res.text);
    return {
      facts: toExtractedFacts(jsonFacts, opts.sessionLabel, opts.timestamp, opts.tool, opts.task),
      usedHeuristic: false,
    };
  } catch (err) {
    process.stderr.write(
      `kb: LLM extraction failed on chunk ${chunkIndex} (${String(err)}); using heuristic fallback.\n`,
    );
    return {
      facts: heuristicExtract(chunkText, opts.sessionLabel, opts.timestamp, opts.tool, opts.task),
      usedHeuristic: true,
    };
  }
}

/**
 * Heuristic fallback when no LLM is available. Scans for lines that look like
 * decisions ("decided", "let's use", "we'll go with") and TODOs. Low quality
 * but keeps the tool useful offline.
 */
export function heuristicExtract(
  text: string,
  source: string,
  timestamp: string,
  tool: SourceTool = "unattributed",
  task?: string,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const decisionCues = [
    "decided to",
    "let's use",
    "we'll use",
    "we'll go with",
    "going with",
    "switched to",
    "use ",
  ];
  const todoCues = ["todo:", "next:", "next steps:", "still need to", "blocked by"];

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length < 10 || t.length > 200) continue;
    const lower = t.toLowerCase();
    if (decisionCues.some((c) => lower.includes(c))) {
      facts.push({
        id: makeFactId(t, tool, "decision"),
        content: t.replace(/^[-*]\s+/, "").slice(0, 200),
        category: "decision",
        source,
        tool,
        task,
        timestamp,
      });
    } else if (todoCues.some((c) => lower.includes(c))) {
      facts.push({
        id: makeFactId(t, tool, "open-question"),
        content: t.replace(/^[-*]\s+/, "").slice(0, 200),
        category: "open-question",
        source,
        tool,
        task,
        timestamp,
      });
    }
  }
  return facts.slice(0, 20);
}
