/**
 * wiki/merger.ts — merge ExtractedFact[] into the wiki.
 *
 * Strategy (simple, robust, v0.1):
 *  - Each fact category maps to a canonical wiki file.
 *  - Before appending, check whether a near-duplicate line already exists
 *    (case-insensitive substring match) and skip if so (dedup).
 *  - Contradictions are detected by a lightweight heuristic: if the new fact
 *    content shares significant keywords with an existing opposite-sense line
 *    (contains "not"/"switched from"/"replaced"), flag it. Flagged facts are
 *    appended with a ⚠️ marker rather than overwriting the old decision.
 */
import type { ExtractedFact, FactCategory, Scope, SourceTool } from "../types.js";
import { readWikiFile, writeWikiFile } from "./engine.js";

const CATEGORY_FILE: Record<FactCategory, string> = {
  decision: "decisions-log.md",
  architecture: "architecture.md",
  pattern: "patterns.md",
  bugfix: "bugs-and-fixes.md",
  "file-change": "project-state.md",
  state: "project-state.md",
  "open-question": "open-questions.md",
  note: "project-state.md",
};

export interface MergeResult {
  filesWritten: string[];
  contradictions: string[];
  skippedDuplicates: number;
  appended: number;
}

/**
 * Extract just the raw fact content from a formatted wiki line.
 *
 * Wiki lines are formatted as:
 *   - **fact content** _(source, 2026-07-05)_
 *   - ⚠️ **fact content** _(source, 2026-07-05)_
 *
 * This strips the bullet, bold markers, contradiction marker, and the
 * trailing source/timestamp suffix so comparison functions see only the
 * actual fact text.
 */
function extractFactContent(line: string): string {
  let t = line.trim();
  // Strip bullet marker ("- " or "* ").
  t = t.replace(/^[-*]\s+/, "");
  // Strip contradiction marker if present.
  t = t.replace(/^⚠️\s*/, "");
  // Strip bold markers around the main content.
  t = t.replace(/^\*\*(.+?)\*\*/, "$1");
  // Strip trailing "_(source, 2026-07-05)_" source/timestamp suffix.
  t = t.replace(/\s*_\([^)]+\)_\s*$/, "");
  return t.trim();
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Token Jaccard similarity in [0,1]. Returns 0 for too-short inputs. */
function jaccard(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 8 || nb.length < 8) return 0;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/** Strict near-duplicate check (used for dedup). */
function similar(a: string, b: string): boolean {
  return jaccard(a, b) > 0.6;
}

/** Looser same-topic check (used for contradiction detection). */
function sameTopic(a: string, b: string): boolean {
  return jaccard(a, b) >= 0.35;
}

const CONTRADICTION_CUES = [
  "switched from",
  "replaced",
  "no longer",
  "reverted",
  "instead of",
  "changed from",
  "not ",
  "don't",
];

function looksContradictory(newContent: string, existingLine: string): boolean {
  if (!sameTopic(newContent, existingLine)) return false;
  const lower = newContent.toLowerCase();
  return CONTRADICTION_CUES.some((c) => lower.includes(c));
}

/**
 * Scan existing wiki file for a duplicate or contradictory line.
 *
 * Two-tier matching:
 *  - First check the loose `sameTopic` gate so contradictions are detected even
 *    when the new fact rewords the existing one heavily (Jaccard ~0.35-0.6).
 *  - A contradiction requires both `sameTopic` AND a contradiction cue.
 *  - A strict near-duplicate (Jaccard > 0.6) without a cue is a dedup skip.
 */
function scanExisting(
  existing: string,
  content: string,
): { dup: boolean; contradiction: boolean } {
  const normContent = normalize(content);
  for (const line of existing.split("\n")) {
    const t = extractFactContent(line);
    if (!t || t.startsWith("#")) continue;
    // Exact re-capture always dedups, even if it contains a cue word like "not".
    if (normContent === normalize(t)) {
      return { dup: true, contradiction: false };
    }
    if (!sameTopic(content, t)) continue;
    if (looksContradictory(content, t)) {
      return { dup: false, contradiction: true };
    }
    if (similar(content, t)) {
      return { dup: true, contradiction: false };
    }
    // same topic, neither a strict dup nor a contradiction — keep scanning;
    // a later line may match more strongly.
  }
  return { dup: false, contradiction: false };
}

export function mergeFacts(
  scope: Scope,
  facts: ExtractedFact[],
  cwd?: string,
  tool?: SourceTool,
): MergeResult {
  const written = new Set<string>();
  const contradictions: string[] = [];
  let skipped = 0;
  let appended = 0;

  // Group facts by target file for tidy output.
  const byFile = new Map<string, ExtractedFact[]>();
  for (const fact of facts) {
    const file = fact.wikiFile ?? CATEGORY_FILE[fact.category];
    const arr = byFile.get(file) ?? [];
    arr.push(fact);
    byFile.set(file, arr);
  }

  for (const [file, group] of byFile) {
    let existing = readWikiFile(scope, file, cwd, tool);
    if (existing.length === 0) {
      existing = `# ${titleForFile(file)}\n\n_Auto-maintained by kb._\n`;
    }
    let changed = false;
    for (const fact of group) {
      const { dup, contradiction } = scanExisting(existing, fact.content);
      if (dup) {
        skipped++;
        continue;
      }
      const block = formatFactBlock(fact, contradiction);
      existing = appendTo(existing, block);
      changed = true;
      appended++;
      if (contradiction) {
        contradictions.push(
          `Possible contradiction in ${file}: "${fact.content}" vs existing entry.`,
        );
      }
    }
    if (changed) {
      writeWikiFile(scope, file, existing, cwd, tool);
      written.add(file);
    }
  }

  return {
    filesWritten: [...written].sort(),
    contradictions,
    skippedDuplicates: skipped,
    appended,
  };
}

function appendTo(existing: string, block: string): string {
  const sep = existing.length > 0 && !existing.endsWith("\n\n") ? "\n\n" : "";
  return existing + sep + block + "\n";
}

function formatFactBlock(fact: ExtractedFact, contradiction: boolean): string {
  const stamp = fact.timestamp.slice(0, 10);
  const marker = contradiction ? "⚠️ " : "";
  const lines: string[] = [];
  lines.push(`- ${marker}**${fact.content}** _(${fact.source}, ${stamp})_`);
  if (fact.rationale) lines.push(`  - Rationale: ${fact.rationale}`);
  return lines.join("\n");
}

function titleForFile(file: string): string {
  const base = file.replace(/\.md$/, "").replace(/-/g, " ");
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}
