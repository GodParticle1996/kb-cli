/**
 * storage.ts — resolves and manages on-disk paths for the project KB (./kb/)
 * and the per-tool global KBs (~/.kb/<tool>/).
 *
 * The "global" scope is no longer a single directory. Each AI coding tool gets
 * its own KB at ~/.kb/<tool>/ (claude, kimi, opencode, codex, cline). A capture
 * fans out across the configured destinations:
 *   - ./kb/                   (project KB, sessions tagged with `.<tool>` suffix)
 *   - ~/.kb/<source-tool>/    (per-tool global KB)
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Scope, SourceTool } from "./types.js";

/** Tools kb knows how to watch / build a KB for. */
export const ALL_TOOLS: SourceTool[] = ["claude", "kimi", "opencode", "codex", "cline"];

/** Root of the kb directory tree (~/.kb). */
export function kbHome(): string {
  const override = process.env.KB_HOME;
  return override ? resolve(override) : join(homedir(), ".kb");
}

/** Root of a per-tool global KB (~/.kb/<tool>). */
export function toolRoot(tool: SourceTool): string {
  return join(kbHome(), tool);
}

/**
 * Root of the (legacy / aggregate) global namespace. There is no single
 * ~/.kb/global directory anymore — kept only for compatibility with callers
 * that need an ~/.kb-level path (e.g. the cache dir lives here). For per-tool
 * storage use toolRoot().
 */
export function legacyGlobalRoot(): string {
  return join(kbHome(), "global");
}

/** Root of the project KB (./kb in the current working directory). */
export function projectRoot(cwd: string = process.cwd()): string {
  return join(cwd, "kb");
}

/**
 * Root directory for a given scope. When scope is "global", a `tool` is required
 * to pick the right per-tool KB (~/.kb/<tool>/). `cwd` is only relevant for the
 * project scope.
 */
export function rootFor(scope: Scope, cwd?: string, tool?: SourceTool): string {
  if (scope === "global") {
    if (!tool || tool === "unattributed") {
      throw new Error("rootFor(global, …) requires a concrete tool (claude|kimi|opencode|codex|cline).");
    }
    return toolRoot(tool);
  }
  return projectRoot(cwd);
}

export function wikiDir(scope: Scope, cwd?: string, tool?: SourceTool): string {
  return join(rootFor(scope, cwd, tool), "wiki");
}

export function vectorsDir(scope: Scope, cwd?: string, tool?: SourceTool): string {
  return join(rootFor(scope, cwd, tool), "vectors");
}

export function sessionsDir(scope: Scope, cwd?: string, tool?: SourceTool): string {
  return join(wikiDir(scope, cwd, tool), "sessions");
}

/** Per-task roll-ups (cross-tool merges for one task) live here. */
export function tasksDir(scope: Scope, cwd?: string, tool?: SourceTool): string {
  return join(wikiDir(scope, cwd, tool), "tasks");
}

export function cacheDir(): string {
  return join(kbHome(), "cache");
}

export function configFile(): string {
  return join(kbHome(), "config.json");
}

export function projectConfigFile(cwd: string = process.cwd()): string {
  return join(projectRoot(cwd), ".kbconfig.json");
}

/** Path to the auto-maintained index.md for a scope. */
export function indexFile(scope: Scope, cwd?: string, tool?: SourceTool): string {
  return join(wikiDir(scope, cwd, tool), "index.md");
}

/** Standard wiki content files (project scope). */
export const PROJECT_WIKI_FILES = [
  "project-state.md",
  "decisions-log.md",
  "architecture.md",
  "bugs-and-fixes.md",
  "patterns.md",
] as const;

export function isKbInitialized(scope: Scope, cwd?: string, tool?: SourceTool): boolean {
  return existsSync(indexFile(scope, cwd, tool));
}

/** List the per-tool global KBs that have been initialized on disk. */
export function listInitializedToolKbs(): SourceTool[] {
  const home = kbHome();
  if (!existsSync(home)) return [];
  const known = new Set<string>(ALL_TOOLS);
  const out: SourceTool[] = [];
  try {
    for (const entry of readdirSync(home)) {
      if (!known.has(entry)) continue;
      if (!existsSync(join(home, entry, "wiki", "index.md"))) continue;
      out.push(entry as SourceTool);
    }
  } catch {
    // ignore
  }
  return out;
}

/** Ensure a directory exists, creating parents as needed. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Ensure the parent directory of a file exists. */
export function ensureParent(file: string): void {
  ensureDir(dirname(file));
}

/**
 * Atomically-ish write a file by writing to a temp file then renaming.
 * Prevents partial writes if the process is interrupted mid-write.
 */
export function atomicWrite(file: string, contents: string): void {
  ensureParent(file);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, file);
}

/** Slugify a feature name into a safe filename stem. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function fileMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A write destination the capture pipeline iterates over. Each capture builds
 * one Destination per place facts should land: the project KB (sessions tagged
 * `.<tool>`), and — when `destinations.global` is on — the per-tool global KB.
 */
export interface Destination {
  scope: Scope;
  tool?: SourceTool;
  /** Absolute KB root for this destination. */
  root: string;
}

/**
 * Resolve the set of destinations a capture should write to, given the source
 * tool and the user's destinations config.
 */
export function destinationsFor(
  config: { destinations?: { project: boolean; global: boolean } },
  tool: SourceTool,
  cwd?: string,
): Destination[] {
  const out: Destination[] = [];
  const proj = config.destinations?.project ?? true;
  const glob = config.destinations?.global ?? true;
  if (proj) out.push({ scope: "project", root: projectRoot(cwd ?? process.cwd()) });
  if (glob && tool !== "unattributed") out.push({ scope: "global", tool, root: toolRoot(tool) });
  return out;
}
