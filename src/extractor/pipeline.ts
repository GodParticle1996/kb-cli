/**
 * extractor/pipeline.ts — orchestrates the full capture pipeline:
 *   raw text -> chunk -> LLM understand (structured summary) +
 *             -> LLM extract (light fact layer)
 *             -> fan out across destinations ->
 *             write structured session file + task roll-up + rolling merge files
 *             -> embed & store -> git commit -> regenerate index.
 *
 * Each capture writes to every destination enabled in config.destinations:
 *   - ./kb/              (project KB; session filename tagged `.<tool>`)
 *   - ~/.kb/<tool>/      (per-tool global KB; session filename untagged)
 *
 * The PRIMARY ~70% artifact is the structured session file (Task / Goal ·
 * Files Traversed · Changes Made · Final Result · Open Threads). The LIGHT
 * ~30% layer is the rolling decisions-log / file-changes merge.
 */
import { randomUUID } from "node:crypto";
import type {
  CaptureResult,
  ExtractedFact,
  KbConfig,
  LlmProvider,
  Scope,
  SourceTool,
} from "../types.js";
import { chunkText, filterSignalChunks } from "./chunker.js";
import { extractFromChunk } from "./llm-extract.js";
import { mergeFacts } from "../wiki/merger.js";
import { regenerateIndex } from "../wiki/indexer.js";
import {
  appendWikiBlock,
  ensureWikiStructure,
  readWikiFile,
  writeWikiFile,
} from "../wiki/engine.js";
import { maybeCommitWiki } from "../git.js";
import { indexVectors } from "../vectors/store.js";
import { NO_LLM_NOTICE } from "./prompts.js";
import { reconcileSummaries, understandSession } from "./understand.js";
import { appendTaskRollup } from "./task-rollup.js";
import { Destination, destinationsFor } from "../storage.js";

export interface PipelineInput {
  raw: string;
  /** Label for the session, e.g. "2025-07-05-auth-refactor". */
  sessionLabel?: string;
  /** Which tool produced the session (claude|kimi|opencode|codex|cline). */
  tool?: string;
  /** Task slug to tag the capture with (joins wiki/tasks/<slug>.md). */
  task?: string;
  provider: LlmProvider | null;
  config: KbConfig;
  cwd?: string;
  /** Optional git ref of the current codebase (grounding). */
  gitRef?: string;
  /**
   * True when this capture is a continuation of an already-captured session
   * (the watcher detected the file grew). The pipeline then appends the new
   * structured summary to the existing session file as a continuation block
   * rather than overwriting it, and skips building a fresh task roll-up so the
   * roll-up reflects the final state, not every delta.
   */
  incremental?: boolean;
}

function timestampNow(): string {
  return new Date().toISOString();
}

function defaultSessionLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}`;
}

export async function runPipeline(input: PipelineInput): Promise<CaptureResult> {
  const cwd = input.cwd;
  const sessionLabel = input.sessionLabel ?? defaultSessionLabel();
  const sessionId = randomUUID();
  const timestamp = timestampNow();
  const tool = (input.tool as SourceTool | undefined) ?? "unattributed";

  if (!input.provider) {
    process.stderr.write(`kb: ${NO_LLM_NOTICE}\n`);
  }

  // Step 1+2: chunk & filter signal.
  const rawChunks = chunkText(input.raw, input.config.chunkSize);
  const chunks = filterSignalChunks(rawChunks);

  // Step 3a: STRUCTURED-SUMMARY extraction (~70% artifact).
  let summaryMd = "";
  let heuristic = !input.provider;
  if (chunks.length === 0) {
    summaryMd = "";
  } else if (chunks.length === 1) {
    const s = await understandSession({
      provider: input.provider,
      tool,
      transcript: chunks[0].text,
      cwd,
      gitRef: input.gitRef,
    });
    summaryMd = s.markdown;
    heuristic = heuristic || s.heuristic;
  } else {
    const drafts: string[] = [];
    for (const c of chunks) {
      const s = await understandSession({
        provider: input.provider,
        tool,
        transcript: c.text,
        cwd,
        gitRef: input.gitRef,
      });
      drafts.push(s.markdown);
      heuristic = heuristic || s.heuristic;
    }
    summaryMd = reconcileSummaries(drafts);
  }

  // Step 3b: LIGHT fact extraction (~30% layer for the rolling merge files).
  const allFacts: ExtractedFact[] = [];
  for (const chunk of chunks) {
    const { facts, usedHeuristic: h } = await extractFromChunk(chunk.text, chunk.index, {
      provider: input.provider,
      sessionLabel,
      timestamp,
      tool,
      task: input.task,
    });
    if (h) heuristic = heuristic || true;
    allFacts.push(...facts);
  }
  for (const f of allFacts) {
    f.tool = tool;
    if (input.task) f.task = input.task;
  }

  // Step 4: fan out across configured destinations.
  const dests = destinationsFor(input.config, tool, cwd);
  const filesWritten = new Set<string>();
  const contradictions: string[] = [];
  let embeddings = 0;
  let committed = false;
  let wroteSummary = false;

  for (const dest of dests) {
    ensureWikiStructure(dest.scope, cwd, dest.tool);

    // Rolling merge (light layer).
    const merge = mergeFacts(dest.scope, allFacts, cwd, dest.tool);
    contradictions.push(...merge.contradictions);

    // Structured session summary (primary artifact).
    if (summaryMd.length > 0) {
      const sessionRel =
        dest.scope === "project"
          ? `sessions/${sessionLabel}${tool !== "unattributed" ? `.${tool}` : ""}.md`
          : `sessions/${sessionLabel}.md`;
      const existing = input.incremental ? readWikiFile(dest.scope, sessionRel, cwd, dest.tool) : "";
      if (input.incremental && existing.length > 0) {
        // Append a continuation block rather than overwriting the original
        // structured summary, so an incrementally-captured session file
        // accumulates per-save understanding instead of being rewritten.
        appendWikiBlock(
          dest.scope,
          sessionRel,
          `## Continuation — ${timestamp}\n\n${summaryMd}`,
          cwd,
          dest.tool,
        );
      } else {
        const header = `# Session: ${sessionLabel}\n\n_Source: ${tool}${input.task ? ` · task: \`${input.task}\`` : ""}${input.gitRef ? ` · git: ${input.gitRef}` : ""}${heuristic ? " · heuristic" : ""} · ${chunks.length} chunk(s) · in ${destLabel(dest)}._\n\n`;
        writeWikiFile(dest.scope, sessionRel, header + summaryMd, cwd, dest.tool);
      }
      merge.filesWritten.push(sessionRel);
      wroteSummary = true;
    }

    // Per-task resume doc.
    if (input.task && summaryMd.length > 0 && !input.incremental) {
      const slug = input.task.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
      const sessionRel =
        dest.scope === "project"
          ? `sessions/${sessionLabel}${tool !== "unattributed" ? `.${tool}` : ""}.md`
          : `sessions/${sessionLabel}.md`;
      const rollupRel = appendTaskRollup(
        dest.scope,
        slug,
        {
          label: sessionLabel,
          tool,
          timestamp,
          sessionRel,
          sessionMarkdown: summaryMd,
        },
        cwd,
        dest.tool,
      );
      merge.filesWritten.push(rollupRel);
    }

    for (const f of merge.filesWritten) filesWritten.add(`${destLabel(dest)}::${f}`);

    // Step 5: embed & store (best-effort).
    try {
      embeddings += await indexVectors(dest.scope, allFacts, input.config, cwd, dest.tool);
    } catch (err) {
      process.stderr.write(`kb: vector indexing skipped for ${destLabel(dest)} (${String(err)}).\n`);
    }

    regenerateIndex(dest.scope, cwd, dest.tool);

    try {
      const did = await maybeCommitWiki(
        dest.scope,
        `session: ${sessionLabel}`,
        { autoCommit: input.config.autoCommit, cwd },
        dest.tool,
      );
      committed = committed || did;
    } catch {
      // ignore per-dest git failures
    }
  }

  const factCount = allFacts.length;
  const summary =
    `Captured ${summaryMd.length > 0 ? "session summary" : "facts"} ` +
    (factCount > 0 ? `+ ${factCount} fact${factCount === 1 ? "" : "s"} ` : "") +
    `across ${filesWritten.size} file${filesWritten.size === 1 ? "" : "s"}` +
    (tool !== "unattributed" ? ` (source: ${tool})` : "") +
    (` (task: ${input.task})` !== "" && input.task ? ` (task: ${input.task})` : "") +
    (contradictions.length > 0 ? `, ${contradictions.length} contradiction${contradictions.length === 1 ? "" : "s"} flagged` : "") +
    (heuristic ? " [heuristic — no LLM key]" : "") +
    (!wroteSummary ? " [no summary — empty transcript]" : "") +
    ` → ${dests.map(destLabel).join(", ")}.`;

  return {
    scope: "project",
    sessionId,
    factsExtracted: factCount,
    filesWritten: [...filesWritten].sort(),
    contradictions,
    embeddings,
    committed,
    summary,
  };
}

function destLabel(d: Destination): string {
  return d.scope === "project" ? "project" : `~/.kb/${d.tool}`;
}
