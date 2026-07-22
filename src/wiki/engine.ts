/**
 * wiki/engine.ts — read/write the structured Markdown wiki.
 *
 * The wiki is a directory of Markdown files (Karpathy LLM Wiki pattern).
 * Facts are merged into well-known files (decisions-log.md, architecture.md,
 * etc.) and per-session summaries live under sessions/.
 *
 * Most APIs take an optional `tool` so a "global" scope routes to the right
 * per-tool KB (~/.kb/<tool>/).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Scope, SourceTool } from "../types.js";
import { atomicWrite, ensureDir, wikiDir } from "../storage.js";

/** Read a wiki file, returning "" if it doesn't exist. */
export function readWikiFile(scope: Scope, relPath: string, cwd?: string, tool?: SourceTool): string {
  const full = join(wikiDir(scope, cwd, tool), relPath);
  if (!existsSync(full)) return "";
  return readFileSync(full, "utf8");
}

/** Write a wiki file (atomic). */
export function writeWikiFile(
  scope: Scope,
  relPath: string,
  contents: string,
  cwd?: string,
  tool?: SourceTool,
): void {
  const full = join(wikiDir(scope, cwd, tool), relPath);
  atomicWrite(full, contents.endsWith("\n") ? contents : contents + "\n");
}

/** Append a Markdown block to an existing wiki file (creating it if needed). */
export function appendWikiBlock(
  scope: Scope,
  relPath: string,
  block: string,
  cwd?: string,
  tool?: SourceTool,
): void {
  const existing = readWikiFile(scope, relPath, cwd, tool);
  const sep = existing.length > 0 && !existing.endsWith("\n\n") ? "\n\n" : "";
  const next = existing + sep + block + "\n";
  writeWikiFile(scope, relPath, next, cwd, tool);
}

export interface WikiFile {
  /** Path relative to the wiki root. */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  /** Size in bytes. */
  bytes: number;
  /** Modification time (ms epoch). */
  mtime: number;
}

/** Recursively list all .md files under the wiki directory. */
export function listWikiFiles(scope: Scope, cwd?: string, tool?: SourceTool): WikiFile[] {
  const root = wikiDir(scope, cwd, tool);
  if (!existsSync(root)) return [];
  const out: WikiFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        out.push({
          relPath: relative(root, full),
          absPath: full,
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Count approximate "facts" in the wiki. A fact is a Markdown list item or a
 * heading-anchored block. We count top-level list items + H3/H4 headings as a
 * rough proxy — precise enough for status output.
 */
export function countFacts(scope: Scope, cwd?: string, tool?: SourceTool): number {
  let count = 0;
  for (const f of listWikiFiles(scope, cwd, tool)) {
    const text = readFileSync(f.absPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (/^[-*]\s+\S/.test(trimmed)) count++;
      else if (/^###\s+\S/.test(trimmed) || /^####\s+\S/.test(trimmed)) count++;
    }
  }
  return count;
}

/** Read the most recently modified session file under sessions/. */
export function latestSessionFile(scope: Scope, cwd?: string, tool?: SourceTool): WikiFile | null {
  const dir = join(wikiDir(scope, cwd, tool), "sessions");
  if (!existsSync(dir)) return null;
  const files = listWikiFiles(scope, cwd, tool).filter((f) =>
    f.relPath.startsWith("sessions/"),
  );
  return files[0] ?? null;
}

/** Ensure the standard wiki directory tree exists for a scope. */
export function ensureWikiStructure(scope: Scope, cwd?: string, tool?: SourceTool): void {
  const root = wikiDir(scope, cwd, tool);
  ensureDir(root);
  ensureDir(join(root, "sessions"));
  ensureDir(join(root, "tasks"));
  if (scope === "global") {
    ensureDir(join(root, "learning"));
    ensureDir(join(root, "patterns"));
  }
}
