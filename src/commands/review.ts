/**
 * commands/review.ts — `kb review` shows recent wiki changes and any flagged
 * contradictions, so you can audit what kb has been capturing.
 *
 *   kb review              review the project KB
 *   kb review --global     review every initialized per-tool global KB
 *   kb review --global --tool codex   review just Codex's global KB
 *   kb review --since 3d   custom time window
 */
import { existsSync } from "node:fs";
import type { KbConfig, Scope, SourceTool } from "../types.js";
import { isKbInitialized, listInitializedToolKbs, rootFor } from "../storage.js";
import { listWikiFiles, readWikiFile } from "../wiki/engine.js";
import { simpleGit } from "simple-git";

export interface ReviewOptions {
  since?: string;
  global?: boolean;
  tool?: string;
  config: KbConfig;
  cwd?: string;
}

interface ReviewTarget {
  scope: Scope;
  tool?: SourceTool;
  label: string;
}

export async function runReview(opts: ReviewOptions): Promise<string> {
  const tool = opts.tool as SourceTool | undefined;
  const knownTool = tool && tool !== "unattributed" ? tool : undefined;

  const targets: ReviewTarget[] = [];
  if (!opts.global) targets.push({ scope: "project", label: "project" });
  if (opts.global || knownTool) {
    if (knownTool) {
      targets.push({ scope: "global", tool: knownTool, label: `~/.kb/${knownTool}` });
    } else {
      for (const t of listInitializedToolKbs()) {
        targets.push({ scope: "global", tool: t, label: `~/.kb/${t}` });
      }
    }
  }

  const sinceMs = parseSince(opts.since ?? "7d");
  const cutoff = Date.now() - sinceMs;
  const lines: string[] = [`# kb review (since ${opts.since ?? "7d"})`, ""];

  for (const t of targets) {
    if (!isKbInitialized(t.scope, opts.cwd, t.tool)) {
      lines.push(`## ${t.label}\n\n_Not initialized._\n`);
      continue;
    }
    lines.push(`## ${t.label}`);

    const files = listWikiFiles(t.scope, opts.cwd, t.tool)
      .filter((f) => f.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) {
      lines.push("_No changes in this period._\n");
      continue;
    }

    lines.push("### Recently modified files");
    for (const f of files) {
      const when = new Date(f.mtime).toLocaleString();
      lines.push(`- ${f.relPath} — _${when}_ (${f.bytes} B)`);
    }
    lines.push("");

    // Contradictions.
    const contradictions: string[] = [];
    for (const f of files) {
      const body = readWikiFile(t.scope, f.relPath, opts.cwd, t.tool);
      for (const line of body.split("\n")) {
        if (line.includes("⚠️")) {
          contradictions.push(`${f.relPath}: ${line.trim()}`);
        }
      }
    }
    lines.push("### Flagged contradictions");
    if (contradictions.length === 0) {
      lines.push("_None._");
    } else {
      for (const c of contradictions) lines.push(`- ${c}`);
    }
    lines.push("");

    // Recent git log.
    const gitLines = await recentGitLog(t.scope, opts.cwd, cutoff, t.tool);
    lines.push("### Recent commits");
    if (gitLines.length === 0) {
      lines.push("_No git history (run with auto-commit enabled)._");
    } else {
      for (const g of gitLines) lines.push(`- ${g}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

function parseSince(s: string): number {
  const m = /^(\d+)([hdw])$/.exec(s.trim().toLowerCase());
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return n * 7 * 24 * 60 * 60 * 1000;
}

async function recentGitLog(
  scope: Scope,
  cwd: string | undefined,
  cutoff: number,
  tool?: SourceTool,
): Promise<string[]> {
  const kbRoot = rootFor(scope, cwd, tool);
  if (!existsSync(`${kbRoot}/.git`)) return [];
  try {
    const git = simpleGit(kbRoot);
    const log = await git.log({ "--since": new Date(cutoff).toISOString() });
    return log.all.map(
      (e: { date: string; message: string }) => `${e.date.slice(0, 10)} ${e.message}`,
    );
  } catch {
    return [];
  }
}
