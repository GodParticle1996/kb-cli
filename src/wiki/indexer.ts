/**
 * wiki/indexer.ts — maintains index.md, an auto-generated table of contents
 * for the wiki, regenerated after every capture.
 */
import type { Scope, SourceTool } from "../types.js";
import { listWikiFiles, readWikiFile, writeWikiFile } from "./engine.js";
import { indexFile } from "../storage.js";

/** Build the index.md content from the current wiki files. */
export function buildIndex(scope: Scope, cwd?: string, tool?: SourceTool): string {
  const files = listWikiFiles(scope, cwd, tool);
  const lines: string[] = ["# Knowledge Base Index", "", "_Auto-maintained by kb._", ""];
  if (files.length === 0) {
    lines.push("_No wiki entries yet. Run `kb capture` to add some._");
    return lines.join("\n") + "\n";
  }
  for (const f of files) {
    if (f.relPath === "index.md") continue;
    const heading = extractFirstHeading(readWikiFile(scope, f.relPath, cwd, tool));
    const label = heading ?? f.relPath.replace(/\.md$/, "");
    const link = f.relPath.replace(/\.md$/, "");
    lines.push(`- [${label}](${link}.md) — _${formatBytes(f.bytes)}_`);
  }
  return lines.join("\n") + "\n";
}

/** Regenerate and write index.md. Returns the path written. */
export function regenerateIndex(scope: Scope, cwd?: string, tool?: SourceTool): string {
  const content = buildIndex(scope, cwd, tool);
  writeWikiFile(scope, "index.md", content, cwd, tool);
  return indexFile(scope, cwd, tool);
}

function extractFirstHeading(md: string): string | null {
  for (const line of md.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
