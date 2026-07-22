/**
 * extractor/understand.ts — the §4.2.1 / §7 structured-session-summary LLM call.
 *
 * Given the transcript of one session (already chunked to fit), ask the LLM to
 * produce a Markdown summary with the five fixed sections (Task / Goal, Files
 * Traversed, Changes Made, Final Result, Open Threads) plus the grounded
 * file:symbol citations.
 *
 * A robust parser normalizes the model output so downstream consumers always
 * see the same five sections in the same order, regardless of whether the
 * model trimmed headers or added extra prose around them.
 */
import type {
  ChatRequest,
  LlmProvider,
  SourceTool,
} from "../types.js";
import { UNDERSTAND_SYSTEM, understandUserPrompt, SUMMARY_SECTIONS } from "./prompts.js";

export interface UnderstandOptions {
  provider: LlmProvider | null;
  tool: SourceTool;
  /** One chunk of the transcript (already filtered by `filterSignalChunks`). */
  transcript: string;
  cwd?: string;
  gitRef?: string;
  maxTokens?: number;
}

export interface SessionSummary {
  /** Raw normalized Markdown with all five sections, in canonical order. */
  markdown: string;
  /** True when the LLM wasn't called (no provider) — used for status output. */
  heuristic: boolean;
  /** The sections that have non-trivial content. */
  hasContent: boolean;
}

/**
 * Run the structured-summary extraction on a single transcript chunk. Returns
 * a normalized SessionSummary. When no provider is available, falls back to a
 * heuristic skeleton that still satisfies the section contract.
 */
export async function understandSession(opts: UnderstandOptions): Promise<SessionSummary> {
  if (!opts.provider) {
    return { markdown: heuristicSummary(opts.transcript, opts.tool), heuristic: true, hasContent: false };
  }
  const req: ChatRequest = {
    system: UNDERSTAND_SYSTEM,
    user: understandUserPrompt({ tool: opts.tool, cwd: opts.cwd, gitRef: opts.gitRef }, opts.transcript),
    maxTokens: opts.maxTokens ?? 3072,
    temperature: 0.2,
  };
  try {
    const res = await opts.provider.chat(req);
    const md = normalizeSummary(res.text);
    return { markdown: md, heuristic: false, hasContent: hasRealContent(md) };
  } catch (err) {
    process.stderr.write(
      `kb: understand() LLM call failed (${String(err)}); using heuristic skeleton.\n`,
    );
    return { markdown: heuristicSummary(opts.transcript, opts.tool), heuristic: true, hasContent: false };
  }
}

/**
 * Normalize an arbitrary LLM response into the canonical five-section form.
 * Strategy:
 *  - Strip code fences / preamble.
 *  - Find each `## <section>` heading and copy everything up to the next `## `
 *    heading (or end). Unknown `## ` headings are dropped.
 *  - Re-emit the five sections in canonical order with whatever content each
 *    has; empty sections get `_None._`.
 */
export function normalizeSummary(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/i, "");

  const bodies = new Map<string, string>();
  for (const section of SUMMARY_SECTIONS) {
    bodies.set(section, extractSection(s, section));
  }
  if ([...bodies.values()].every((b) => b.trim().length === 0)) {
    bodies.set("Task / Goal", s.replace(/^#{1,6}\s+.*$/m, "").trim() || s);
  }

  const out: string[] = [];
  for (const section of SUMMARY_SECTIONS) {
    const body = (bodies.get(section) ?? "").trim();
    out.push(`## ${section}`, "", body.length > 0 ? body : "_None._", "");
  }
  return out.join("\n").trim() + "\n";
}

/**
 * Reconcile per-chunk drafts into one canonical session summary. Strategy:
 * each section's bullets from every chunk are concatenated in document order
 * (chunks are processed left-to-right, so already chronological). The first
 * non-`_None._` Task/Goal across all chunks wins as the goal statement;
 * subsequent chunks' goals are appended as additional context lines.
 */
export function reconcileSummaries(drafts: string[]): string {
  if (drafts.length === 0) return "";
  if (drafts.length === 1) return drafts[0];

  const collected: Record<string, string[]> = {};
  for (const section of SUMMARY_SECTIONS) collected[section] = [];
  const goalProse: string[] = [];
  let goalChosen = false;

  for (const draft of drafts) {
    for (const section of SUMMARY_SECTIONS) {
      const body = extractSection(draft, section).trim();
      if (body.length === 0 || /^_?none\.?_?$/i.test(body)) continue;
      if (section === "Task / Goal" && !goalChosen) {
        goalProse.push(body);
        goalChosen = true;
      } else if (section === "Task / Goal") {
        // Later chunks: keep as additional context bullets under the first goal.
        for (const line of body.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          goalProse.push(t);
        }
      } else {
        collected[section].push(body);
      }
    }
  }

  const out: string[] = [];
  out.push("## Task / Goal", "", goalProse.length > 0 ? goalProse.join("\n") : "_None._", "");
  for (const section of SUMMARY_SECTIONS) {
    if (section === "Task / Goal") continue;
    const bodies = collected[section];
    const body = bodies.length > 0 ? bodies.join("\n\n") : "_None._";
    out.push(`## ${section}`, "", body, "");
  }
  return out.join("\n").trim() + "\n";
}

export function extractSection(md: string, heading: string): string {
  const lower = heading.toLowerCase();
  const lines = md.split("\n");
  let capturing = false;
  let captureLevel = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      const title = m[2];
      if (!capturing) {
        if (level === 2 && title.toLowerCase().includes(lower)) {
          capturing = true;
          captureLevel = 2;
        }
        continue;
      }
      if (level <= captureLevel) break;
      out.push(line);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n").trim();
}

/** True if at least one section other than Open Threads carries real content. */
export function hasRealContent(normalizedMd: string): boolean {
  for (const section of SUMMARY_SECTIONS) {
    if (section === "Open Threads") continue;
    const body = extractSection(normalizedMd, section);
    if (body.length > 0 && !/^_?none\.?_?$/i.test(body.trim())) return true;
  }
  return false;
}

/**
 * Heuristic skeleton used when no LLM is configured. It still emits the five
 * sections so the file format is consistent; one-shot `kb inject --task <slug>`
 * can still surface something useful.
 */
export function heuristicSummary(transcript: string, tool: SourceTool): string {
  const firstLines = transcript.split("\n").filter((l) => l.trim().length > 0).slice(0, 3).join("\n");
  const decisions = extractHeuristicLines(transcript, ["decided to", "let's use", "we'll use", "we'll go with", "switched to", "use "]);
  const todos = extractHeuristicLines(transcript, ["todo:", "next:", "next steps:", "still need to", "blocked by"]);
  const changes = extractHeuristicLines(transcript, ["edited ", "modified ", "wrote ", "created ", "added ", "updated "]);

  return [
    "## Task / Goal",
    "",
    firstLines.slice(0, 512) || "_(transcript too sparse to infer goal.)_",
    "",
    "## Files Traversed",
    "",
    `_(source tool: ${tool}; heuristic fallback — no LLM.)_`,
    "",
    "## Changes Made",
    "",
    changes.length > 0 ? changes.map((c) => `- ${c}`).join("\n") : "_None._",
    "",
    "## Final Result",
    "",
    "_Unknown (no LLM ran; heuristic fallback)._",
    "",
    "## Open Threads",
    "",
    todos.length > 0 ? todos.map((t) => `- ${t}`).join("\n") : "_None._",
    "",
  ].join("\n");
}

function extractHeuristicLines(text: string, cues: string[]): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/^[-*]\s+/, "");
    if (t.length < 10 || t.length > 200) continue;
    const lower = t.toLowerCase();
    if (cues.some((c) => lower.includes(c))) out.push(t.slice(0, 200));
  }
  return out.slice(0, 12);
}
