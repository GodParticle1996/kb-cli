/**
 * extractor/prompts.ts — system/user prompt templates for the extraction LLM.
 *
 * Two extraction modes are supported:
 *
 *  1. **Structured session summary** (UNDERSTAND_*): the primary ~70% artifact.
 *     The LLM derives a *logical* understanding of the whole session, not a
 *     literal log — Task/Goal · Files Traversed (with why + symbol logic) ·
 *     Changes Made (file:symbol + reason) · Final Result · Open Threads.
 *
 *  2. **Fact list** (EXTRACTION_*): the light ~30% layer that gets merged into
 *     the rolling topic files (decisions-log.md, file-changes.md, …). Kept
 *     so durable decisions accumulate across many sessions.
 */

// ---------------------------------------------------------------------------
// Mode 1 — structured session summary (primary artifact, §4.2.1 / §7)
// ---------------------------------------------------------------------------

export const UNDERSTAND_SYSTEM = `You are the comprehension layer of a Central Memory for AI coding tools.
You read a transcript of one session produced by an AI coding assistant in a codebase and derive a LOGICAL understanding of it — not a literal summary of messages.

Produce Markdown and only Markdown (no fences, no preamble) with EXACTLY these sections, in this order:

## Task / Goal
1–2 sentences on the end intention of this session. The *why*, not the *what*.

## Files Traversed
Every file / symbol the session read or reasoned about, grouped by the chain of reasoning that led there. For each entry:
- \`path/to/file.ts:symbolName\` — one sentence on WHY it was checked and WHAT its role is here.
Prefer a short narrative over a flat list; show the traversal path, not just every file. If a symbol was inferred but not literally named in the transcript, mark it \`(inferred)\`. Do NOT invent files that do not appear in the transcript.

## Changes Made
Every edit (or explicit "no change") as \`path/to/file.ts:symbolName\` plus one sentence on WHY the edit advanced the goal. If a commit / diff stat is visible, include it. Skip pure reads here — those belong in Files Traversed.

## Final Result
Whether the goal was reached, the observable end state (tests pass? feature works? bug fixed?), and any verification mentioned.

## Open Threads
Concrete next steps the next session should pick up. Numbered list.

Rules:
- Cite real \`file:symbol\` references that appear in the transcript. Mark inferred symbols with \`(inferred)\`.
- Be specific about reasoning. "Because X depends on Y" beats "looked at Y".
- If a section has no content, write \`_None_\` — do not omit sections.
`;

export interface UnderstandContext {
  tool: string;
  cwd?: string;
  gitRef?: string;
}

/** Build the user prompt for the structured-summary extraction call. */
export function understandUserPrompt(ctx: UnderstandContext, transcript: string): string {
  const headerLines = [
    `Source tool: ${ctx.tool}`,
    ctx.cwd ? `Working directory: ${ctx.cwd}` : null,
    ctx.gitRef ? `Git ref: ${ctx.gitRef}` : null,
  ].filter(Boolean) as string[];
  const header = headerLines.length > 0 ? `(${headerLines.join(", ")})\n\n` : "";
  return `${header}Below is a transcript excerpt from one AI coding session. Derive the structured understanding per the system prompt.\n\nTranscript:\n"""\n${transcript}\n"""`;
}

// ---------------------------------------------------------------------------
// Mode 2 — fact list (light rolling layer, ~30%)
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM = `You are a knowledge extraction engine for a Central Memory that stores AI coding session context.
Read a transcript excerpt and extract DURABLE facts worth remembering long-term — not chit-chat, not transient status.

Extract facts in these categories:
- "decision": a concrete decision made, with rationale. e.g. "Use Redis for session caching"
- "architecture": a structural/architectural choice or component description
- "pattern": a coding pattern, convention, or approach established
- "bugfix": a bug found and how it was fixed
- "file-change": a notable file created/modified and why
- "state": current project state, what's in progress, blockers, next steps
- "open-question": an unresolved question or TODO
- "note": any other durable, reusable knowledge

Rules:
- Each "content" must be a single concise sentence (<= 120 chars).
- "rationale" is optional but valuable for decisions and patterns.
- Be specific. "Decided to use X" not "Discussed options".
- Return STRICT JSON only. No prose, no markdown fences.`;

export interface ExtractionJsonFact {
  content: string;
  category: string;
  rationale?: string;
}

/** Build the user prompt for fact extraction on a chunk. */
export function extractionUserPrompt(sessionLabel: string, chunk: string): string {
  return `Session: ${sessionLabel}

Below is a transcript excerpt from an AI coding session. Extract durable facts.

Transcript:
"""
${chunk}
"""

Return a JSON array of objects with this shape:
{"content": string, "category": "decision"|"architecture"|"pattern"|"bugfix"|"file-change"|"state"|"open-question"|"note", "rationale"?: string}

If there are no durable facts in this excerpt, return [].`;
}

/** Heuristic fallback notice used when NO LLM provider is available. */
export const NO_LLM_NOTICE =
  "No LLM provider API key detected. Falling back to heuristic extraction (lower quality). Set GROQ_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY for better results.";

/** Required section headings in a structured summary, in order. */
export const SUMMARY_SECTIONS = [
  "Task / Goal",
  "Files Traversed",
  "Changes Made",
  "Final Result",
  "Open Threads",
] as const;
