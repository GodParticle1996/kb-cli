/**
 * commands/init.ts — `kb init` initializes a knowledge base.
 *
 *   kb init              → ./kb/ (project scope)
 *   kb init --global     → every per-tool global KB (~/.kb/<tool>/)
 *   kb init --global --tool claude → just Claude's global KB
 *
 * Creates the wiki directory tree, standard content files with title headers,
 * an empty sessions/ dir, and an index.md per KB.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Scope, SourceTool } from "../types.js";
import {
  ALL_TOOLS,
  PROJECT_WIKI_FILES,
  configFile,
  ensureDir,
  indexFile,
  isKbInitialized,
  projectRoot,
  sessionsDir,
  toolRoot,
  wikiDir,
} from "../storage.js";
import { ensureWikiStructure, writeWikiFile } from "../wiki/engine.js";
import { regenerateIndex } from "../wiki/indexer.js";
import { saveConfig, DEFAULT_CONFIG } from "../config.js";

const FILE_TITLES: Record<string, string> = {
  "project-state.md": "Project State",
  "decisions-log.md": "Decisions Log",
  "architecture.md": "Architecture",
  "patterns.md": "Patterns & Conventions",
  "bugs-and-fixes.md": "Bugs & Fixes",
};

const GLOBAL_SUBDIRS = ["learning", "patterns", "sessions", "tasks"];

export interface InitOptions {
  global?: boolean;
  tool?: string;
  cwd?: string;
}

export interface InitResult {
  roots: { scope: Scope; tool?: SourceTool; root: string; created: boolean }[];
  scope: Scope;
  root: string;
  created: boolean;
}

export function runInit(opts: InitOptions = {}): InitResult {
  if (opts.global) return initGlobal(opts);
  return initProject(opts);
}

function initProject(opts: InitOptions): InitResult {
  const cwd = opts.cwd;
  const root = projectRoot(cwd);
  ensureWikiStructure("project", cwd);
  ensureDir(sessionsDir("project", cwd));
  const created = !isKbInitialized("project", cwd);
  for (const file of PROJECT_WIKI_FILES) {
    const title = FILE_TITLES[file] ?? file.replace(/\.md$/, "");
    writeWikiFile("project", file, `# ${title}\n\n_Auto-maintained by kb._\n`, cwd);
  }
  regenerateIndex("project", cwd);
  return {
    roots: [{ scope: "project", root, created }],
    scope: "project",
    root,
    created,
  };
}

function initGlobal(opts: InitOptions): InitResult {
  const tool = opts.tool as SourceTool | undefined;
  const knownTool = tool && tool !== "unattributed" ? tool : undefined;
  const toolsToInit: SourceTool[] = knownTool ? [knownTool] : (ALL_TOOLS as SourceTool[]);

  let createdCount = 0;
  const roots: InitResult["roots"] = [];
  for (const t of toolsToInit) {
    ensureWikiStructure("global", undefined, t);
    ensureDir(sessionsDir("global", undefined, t));
    for (const sub of GLOBAL_SUBDIRS) ensureDir(join(wikiDir("global", undefined, t), sub));
    const created = !isKbInitialized("global", undefined, t);
    if (created) createdCount++;
    regenerateIndex("global", undefined, t);
    roots.push({ scope: "global", tool: t, root: toolRoot(t), created });
  }

  // Ensure a global config exists so the tool is usable immediately.
  if (!existsSync(configFile())) saveConfig(DEFAULT_CONFIG);

  const root = roots[0]?.root ?? toolRoot("claude");
  return {
    roots,
    scope: "global",
    root,
    created: createdCount > 0,
  };
}

export function initSummary(result: InitResult): string {
  if (result.roots.length === 1) {
    const r = result.roots[0];
    const verb = r.created ? "Initialized" : "Refreshed";
    const where = r.scope === "global" ? `Global KB (${r.tool})` : "Project KB";
    return `${verb} ${where} at ${r.root}\n  index: ${indexFile(r.scope, undefined, r.tool)}`;
  }
  const initCount = result.roots.filter((r) => r.created).length;
  const lines = [
    `Initialized ${initCount}/${result.roots.length} per-tool global KB(s):`,
    ...result.roots.map((r) => `  ${r.created ? "+ " : "= "}~/.kb/${r.tool}`),
  ];
  return lines.join("\n");
}
