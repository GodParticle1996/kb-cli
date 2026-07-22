/**
 * extractor/task-rollup.ts — builds / appends to wiki/tasks/<slug>.md, the
 * "resume document" that fuses every session (from any tool, across scopes)
 * that worked on a task.
 *
 * Each captured session contributes a single roll-up block that links to the
 * structured session file. The roll-up file itself has this shape:
 *
 *   # Task: <slug>
 *   _Auto-maintained by kb. Last updated <date>._
 *
 *   ## Sessions (chronological)
 *   ### <label> — <tool>, <date>
 *   - goal: <one-liner from the session's Task/Goal section>
 *   - files: <n> traversed · changes: <m> made · open threads: <k>
 *   session: sessions/<file>.<tool>.md
 *
 *   ### ...
 *
 *   ## Current open threads (from the most recent session)
 *   - <each Open Threads bullet>
 *
 * This way a `kb inject --task <slug>` reader sees the whole arc and the
 * concrete next steps, without re-reasoning through every session.
 */
import type { Scope, SourceTool } from "../types.js";
import { readWikiFile, writeWikiFile } from "../wiki/engine.js";
import { extractSection } from "./understand.js";

export interface TaskRollupBlock {
  label: string;
  tool: SourceTool;
  timestamp: string;
  /** Relative path to the structured session file (for cross-reference). */
  sessionRel: string;
  /** Normalized session-summary Markdown produced by understand(). */
  sessionMarkdown: string;
}

/** Build a single chronological roll-up block from a captured session. */
export function buildTaskRollupBlock(b: TaskRollupBlock): string {
  const date = b.timestamp.slice(0, 10);
  const goal = firstLine(extractSection(b.sessionMarkdown, "Task / Goal")) ?? "_(unspecified)_";
  const files = countBullets(extractSection(b.sessionMarkdown, "Files Traversed"));
  const changes = countBullets(extractSection(b.sessionMarkdown, "Changes Made"));
  const threads = countBullets(extractSection(b.sessionMarkdown, "Open Threads"));

  return [
    `### ${b.label} — ${b.tool}, ${date}`,
    "",
    `- **goal:** ${goal}`,
    `- files: ${files} traversed · changes: ${changes} made · open threads: ${threads}`,
    `- session: \`${b.sessionRel}\``,
    "",
  ].join("\n");
}

/** Append a block to a task roll-up file (creating it if needed), then re-emit
 *  the trailing "Current open threads" section so it always reflects the latest. */
export function appendTaskRollup(
  scope: Scope,
  slug: string,
  block: TaskRollupBlock,
  cwd?: string,
  tool?: SourceTool,
): string {
  const rel = `tasks/${slug}.md`;
  let existing = readWikiFile(scope, rel, cwd, tool);

  const headSep = "\n\n## Current open threads";
  const head = existing.split(headSep)[0].trim();

  let title: string;
  if (!head.startsWith("# Task:")) {
    title = `# Task: ${slug}\n\n_Auto-maintained by kb. Last updated ${block.timestamp.slice(0, 10)}._\n\n## Sessions (chronological)\n`;
  } else if (!head.includes("## Sessions (chronological)")) {
    title = head + `\n\n## Sessions (chronological)\n`;
  } else {
    title = head;
  }

  const newBlockMd = buildTaskRollupBlock(block);
  const merged = `${title}${title.endsWith("\n") ? "" : "\n"}${newBlockMd}`;

  // Re-emit the latest open threads at the end.
  const threadsSection = extractSection(block.sessionMarkdown, "Open Threads");
  const threadsLines = threadsSection
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith("- ") || /^(\d+\.)\s+/.test(l));

  let tail = "";
  if (threadsLines.length > 0) {
    tail = `\n\n## Current open threads (from ${block.label}, ${block.tool})\n\n${threadsLines.join("\n")}\n`;
  }

  const next = merged + tail;
  writeWikiFile(scope, rel, next, cwd, tool);
  return rel;
}

function firstLine(sectionBody: string): string | null {
  for (const line of sectionBody.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    return t
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^\*\*(.+?)\*\*/, "$1")
      .slice(0, 200);
  }
  return null;
}

function countBullets(sectionBody: string): number {
  let n = 0;
  for (const line of sectionBody.split("\n")) {
    const t = line.trim();
    if (/^[-*]\s+\S/.test(t)) n++;
  }
  return n;
}
