/**
 * watcher/providers.ts — locators for each supported AI tool's session files.
 *
 * Research-backed paths:
 *  - Claude Code: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl  (JSONL, 30d)
 *  - Cline:       ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/api_conversation_history.json
 *  - Kimchi:      <cwd>/.kimchi/sessions/<timestamp>.jsonl
 *
 * Each locator returns the most recently modified session file for the current
 * working directory, plus a function to read its content as plain text.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionFile {
  /** Which tool produced this session. */
  tool: "claude" | "cline" | "kimi" | "opencode" | "codex";
  /** Absolute path to the session file. */
  path: string;
  /** Modification time (ms epoch). */
  mtime: number;
  /** Read the session content as normalized plain text. */
  read: () => string;
}

function newest(files: string[]): string | null {
  let best: string | null = null;
  let bestMtime = 0;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    } catch {
      // ignore unreadable files
    }
  }
  return best;
}

/**
 * Heuristic: does the session transcript reference `cwd` as its working
 * directory? Used to scope the *globally-stored* session locators (OpenCode,
 * Cline) to the project the watcher is actually running in, so a `kb start`
 * inside project A doesn't ingest project B's sessions.
 */
function sessionBelongsToCwd(file: string, cwd: string): boolean {
  const target = cwd.replace(/\/$/, "");
  if (!target) return true;
  try {
    return readFileSync(file, "utf8").includes(target);
  } catch {
    return false;
  }
}

/** Filter candidate session files to those belonging to `cwd`; fall back to all. */
function scopedCandidates(files: string[], cwd: string): string[] {
  const matched = files.filter((f) => sessionBelongsToCwd(f, cwd));
  return matched.length > 0 ? matched : files;
}

/** Encode a cwd path the way Claude Code does: replace path separators with '-'. */
function encodeClaudePath(cwd: string): string {
  // Claude Code encodes absolute paths by replacing '/' (and leading '/') with '-'.
  return cwd.replace(/\//g, "-").replace(/^-+/, "-");
}

/** Locate the most recent Claude Code session for the given cwd. */
export function findClaudeSession(cwd: string): SessionFile | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  // Match either the exact-encoded cwd or any project dir (fallback to newest).
  const encoded = encodeClaudePath(cwd);
  const projectDirs = readdirSync(projectsDir).map((d) => ({
    d,
    full: join(projectsDir, d),
  }));
  // Prefer the exact match; otherwise pick the newest project dir overall.
  let target = projectDirs.find((p) => p.d === encoded)?.full;
  if (!target) {
    let bestMtime = 0;
    for (const p of projectDirs) {
      try {
        const m = statSync(p.full).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          target = p.full;
        }
      } catch {
        // ignore
      }
    }
  }
  if (!target || !existsSync(target)) return null;
  const jsonlFiles: string[] = [];
  for (const entry of readdirSync(target)) {
    if (entry.endsWith(".jsonl")) jsonlFiles.push(join(target, entry));
  }
  const file = newest(jsonlFiles);
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  return {
    tool: "claude",
    path: file,
    mtime,
    read: () => readClaudeJsonl(file),
  };
}

/** Extract plain text from a Claude Code JSONL transcript. */
function readClaudeJsonl(file: string): string {
  const lines: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const role = obj.type ?? obj.role ?? "unknown";
      const content = extractText(obj.message ?? obj.content ?? obj);
      if (content) lines.push(`### ${role}\n${content}`);
    } catch {
      // skip malformed lines
    }
  }
  return lines.join("\n\n");
}

function extractText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const bb = b as Record<string, unknown>;
          if (typeof bb.text === "string") return bb.text;
          if (typeof bb.content === "string") return bb.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Locate the most recent Cline task for the given cwd (global storage). */
export function findClineSession(cwd: string): SessionFile | null {
  const base = join(
    homedir(),
    ".config",
    "Code",
    "User",
    "globalStorage",
    "saoudrizwan.claude-dev",
    "tasks",
  );
  if (!existsSync(base)) return null;
  const taskDirs: string[] = [];
  for (const entry of readdirSync(base)) {
    const full = join(base, entry);
    try {
      if (statSync(full).isDirectory()) taskDirs.push(full);
    } catch {
      // ignore
    }
  }
  const candidates: string[] = [];
  for (const dir of taskDirs) {
    const hist = join(dir, "api_conversation_history.json");
    if (existsSync(hist)) candidates.push(hist);
  }
  const scoped = scopedCandidates(candidates, cwd);
  const file = newest(scoped);
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  return { tool: "cline", path: file, mtime, read: () => readClineJson(file) };
}

/** Extract plain text from a Cline api_conversation_history.json file. */
function readClineJson(file: string): string {
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as Array<{
      role?: string;
      content?: string;
    }>;
    return arr
      .map((m) => `### ${m.role ?? "unknown"}\n${m.content ?? ""}`)
      .join("\n\n");
  } catch {
    return "";
  }
}

/** Locate the most recent Kimchi session for the given cwd (project-local). */
export function findKimchiSession(cwd: string): SessionFile | null {
  const dir = join(cwd, ".kimchi", "sessions");
  if (!existsSync(dir)) return null;
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".jsonl")) files.push(join(dir, entry));
  }
  const file = newest(files);
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  // Tool identity is `kimi` (Kimchi); the project dir is `.kimchi`.
  return { tool: "kimi", path: file, mtime, read: () => readClaudeJsonl(file) };
}

/** `kimi` is an alias for Kimchi (the tool's project dir is `.kimchi`). */
export const findKimiSession = findKimchiSession;

/** Locate the most recent OpenCode session (XDG-local share, JSONL). */
export function findOpenCodeSession(cwd: string): SessionFile | null {
  const dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "sessions");
  if (!existsSync(dir)) return null;
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".jsonl")) files.push(join(dir, entry));
  }
  const scoped = scopedCandidates(files, cwd);
  const file = newest(scoped);
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  return { tool: "opencode", path: file, mtime, read: () => readClaudeJsonl(file) };
}

/** Locate the most recent Codex session (project-local `.codex` dir, JSONL). */
export function findCodexSession(cwd: string): SessionFile | null {
  const dir = join(cwd, ".codex", "sessions");
  if (!existsSync(dir)) return null;
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".jsonl")) files.push(join(dir, entry));
  }
  const file = newest(files);
  if (!file) return null;
  const mtime = statSync(file).mtimeMs;
  return { tool: "codex", path: file, mtime, read: () => readClaudeJsonl(file) };
}

export type SessionLocator = (cwd: string) => SessionFile | null;

export const SESSION_LOCATORS: Record<string, SessionLocator> = {
  claude: findClaudeSession,
  cline: findClineSession,
  kimchi: findKimchiSession,
  kimi: findKimiSession,
  opencode: findOpenCodeSession,
  codex: findCodexSession,
};

/** Names of every tool the watcher knows how to find sessions for. */
export const KNOWN_TOOLS = ["claude", "kimi", "opencode", "codex", "cline"];

/** Find the most recent session across a set of tools for the current cwd. */
export function findLatestSession(
  tools: string[],
  cwd: string = process.cwd(),
): SessionFile | null {
  const found: SessionFile[] = [];
  for (const tool of tools) {
    const loc = SESSION_LOCATORS[tool];
    if (loc) {
      const s = loc(cwd);
      if (s) found.push(s);
    }
  }
  if (found.length === 0) return null;
  return found.sort((a, b) => b.mtime - a.mtime)[0];
}
