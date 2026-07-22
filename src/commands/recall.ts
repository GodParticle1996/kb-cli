/**
 * commands/recall.ts — `kb recall` runs semantic search across the KBs.
 *
 *   kb recall "PostgreSQL indexing"          project + every per-tool global KB
 *   kb recall --project "auth middleware"   project KB only
 *   kb recall --global "design patterns"     per-tool global KBs only
 *   kb recall --tool claude "decisions"      restrict to Claude (project + ~/.kb/claude)
 *   kb recall --max 10 "error handling"
 */
import type { KbConfig, Scope, SourceTool } from "../types.js";
import { searchVectors, SearchHit } from "../vectors/store.js";
import { listInitializedToolKbs } from "../storage.js";

export interface RecallOptions {
  query: string;
  project?: boolean;
  global?: boolean;
  tool?: string;
  max?: number;
  config: KbConfig;
  cwd?: string;
}

interface RecallTarget {
  scope: Scope;
  tool?: SourceTool;
  label: string;
}

export async function runRecall(opts: RecallOptions): Promise<SearchHit[]> {
  const max = opts.max ?? 5;
  const tool = opts.tool as SourceTool | undefined;
  const knownTool = tool && tool !== "unattributed" ? tool : undefined;

  const targets: RecallTarget[] = [];
  const wantProject = !opts.global || opts.project;
  const wantGlobal = !opts.project || opts.global;
  if (wantProject) targets.push({ scope: "project", label: "project" });
  if (wantGlobal) {
    if (knownTool) {
      targets.push({ scope: "global", tool: knownTool, label: `~/.kb/${knownTool}` });
    } else if (!opts.tool) {
      for (const t of listInitializedToolKbs()) {
        targets.push({ scope: "global", tool: t, label: `~/.kb/${t}` });
      }
    } else if (opts.tool === "unattributed") {
      // explicitly asked for unattributed — nothing to recall.
    }
  }

  const hits: SearchHit[] = [];
  for (const t of targets) {
    const found = await searchVectors(t.scope, opts.query, opts.config, {
      max,
      cwd: opts.cwd,
      tool: t.tool as string | undefined,
    });
    hits.push(...found.map((h) => ({ ...h, _scope: t.label })));
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max) as SearchHit[];
}

export function formatRecallHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "kb: no matches found.";
  const lines: string[] = [`kb: ${hits.length} match${hits.length === 1 ? "" : "es"}`, ""];
  for (const h of hits) {
    const scope = (h as SearchHit & { _scope?: string })._scope ?? "project";
    const score = (h.score * 100).toFixed(0);
    lines.push(`• [${scope}] ${h.text}  (_${h.tool}/${h.category}, ${score}%_)`);
    if (h.wikiFile) lines.push(`    → ${h.wikiFile}`);
  }
  return lines.join("\n");
}
