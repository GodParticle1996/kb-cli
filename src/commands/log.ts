/**
 * commands/log.ts — `kb log` adds a manually-authored fact to the wiki.
 *
 *   kb log "Decided to use Redis for session caching"
 *   kb log --category decision "Switched from Jest to Vitest"
 *   kb log --tool claude --task refactor-auth "spotted race in refreshToken"
 *   kb log --global "Learned that pgvector supports HNSW indexes"   (writes to ~/.kb/<tool>/)
 *
 * This bypasses the LLM extraction pipeline — it's for facts you already know
 * you want to persist. `--global` writes only to the per-tool global KB
 * (~/.kb/<tool>/); without `--global` it writes to the project KB (./kb/).
 */
import { randomUUID } from "node:crypto";
import type { ExtractedFact, FactCategory, KbConfig, SourceTool } from "../types.js";
import { mergeFacts } from "../wiki/merger.js";
import { regenerateIndex } from "../wiki/indexer.js";
import { ensureWikiStructure, appendWikiBlock } from "../wiki/engine.js";
import { maybeCommitWiki } from "../git.js";

export interface LogOptions {
  message: string;
  category?: string;
  global?: boolean;
  tool?: string;
  task?: string;
  rationale?: string;
  config: KbConfig;
  cwd?: string;
}

const VALID: FactCategory[] = [
  "decision",
  "architecture",
  "pattern",
  "bugfix",
  "file-change",
  "state",
  "open-question",
  "note",
];

export async function runLog(opts: LogOptions): Promise<string> {
  const tool = coerceTool(opts.tool);
  // --global writes to the per-tool global KB; default writes to ./kb/.
  const scope = opts.global ? "global" : "project";
  const dstTool = opts.global ? tool : undefined;
  const category = coerceCategory(opts.category);
  const timestamp = new Date().toISOString();
  const source = `manual-${timestamp.slice(0, 10)}`;

  ensureWikiStructure(scope, opts.cwd, dstTool);

  const fact: ExtractedFact = {
    id: `log-${randomUUID()}`,
    content: opts.message.trim(),
    category,
    rationale: opts.rationale,
    source,
    tool,
    task: opts.task,
    timestamp,
  };

  const merge = mergeFacts(scope, [fact], opts.cwd, dstTool);

  // When a task slug is given, also append to the per-task roll-up.
  if (opts.task) {
    const slug = opts.task.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const date = timestamp.slice(0, 10);
    appendWikiBlock(
      scope,
      `tasks/${slug}.md`,
      `## manual log (${tool}, ${date})${opts.rationale ? ` — ${opts.rationale}` : ""}\n\n- **${opts.message.trim()}**`,
      opts.cwd,
      dstTool,
    );
    merge.filesWritten.push(`tasks/${slug}.md`);
  }

  regenerateIndex(scope, opts.cwd, dstTool);
  let committed = false;
  try {
    committed = await maybeCommitWiki(scope, `manual log: ${opts.message.slice(0, 60)}`, {
      autoCommit: opts.config.autoCommit,
      cwd: opts.cwd,
    }, dstTool);
  } catch {
    committed = false;
  }

  const where = scope === "global" ? `~/.kb/${tool}` : "project KB";
  let out = `kb: logged to ${where} (${merge.filesWritten[0] ?? category}` +
    (tool !== "unattributed" ? `, source: ${tool}` : "") +
    (opts.task ? `, task: ${opts.task}` : "") + ").";
  if (merge.skippedDuplicates > 0) out += " (duplicate skipped)";
  if (committed) out += " (committed)";
  return out;
}

function coerceCategory(s?: string): FactCategory {
  if (!s) return "note";
  const lower = s.toLowerCase().trim();
  return (VALID as string[]).includes(lower) ? (lower as FactCategory) : "note";
}

function coerceTool(s?: string): SourceTool {
  if (!s) return "unattributed";
  const lower = s.toLowerCase().trim();
  const valid: SourceTool[] = ["claude", "kimi", "opencode", "codex", "cline", "unattributed"];
  return (valid as string[]).includes(lower) ? (lower as SourceTool) : "unattributed";
}
