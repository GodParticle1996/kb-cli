/**
 * commands/inject.ts — `kb inject` reads the wiki and produces a structured
 * context injection prompt to paste/pipe into a new AI session.
 *
 *   kb inject                     project KB (all tools' work on this codebase)
 *   kb inject --tool claude        only Claude's memory (project KB + Claude's global KB)
 *   kb inject --global             all per-tool global KBs (~/.kb/<tool>/)
 *   kb inject --global --tool codex  just Codex's global KB
 *   kb inject --task <slug>        the cross-tool roll-up for one task
 *   kb inject --last               only the most recent session summary
 *   kb inject --topic "auth"       filter sections/facts mentioning a topic
 *   kb inject --copy               copy output to clipboard
 */
import { execSync } from "node:child_process";
import type { Scope, SourceTool } from "../types.js";
import { isKbInitialized, listInitializedToolKbs } from "../storage.js";
import { latestSessionFile, listWikiFiles, readWikiFile } from "../wiki/engine.js";

export interface InjectOptions {
  global?: boolean;
  tool?: string;
  task?: string;
  topic?: string;
  last?: boolean;
  copy?: boolean;
  cwd?: string;
}

const SECTION_ORDER = [
  "project-state.md",
  "decisions-log.md",
  "architecture.md",
  "patterns.md",
  "bugs-and-fixes.md",
  "open-questions.md",
];

/** The set of (scope, tool?) targets inject should read from. */
type Target = { scope: Scope; tool?: SourceTool; label: string };

function resolveTargets(opts: InjectOptions): Target[] {
  const out: Target[] = [];
  const tool = opts.tool as SourceTool | undefined;
  const knownTool = tool && tool !== "unattributed" ? tool : undefined;
  // Project KB first (when not --global).
  if (!opts.global) out.push({ scope: "project", label: "project" });
  // Per-tool global KBs.
  if (opts.global || knownTool) {
    if (knownTool) {
      out.push({ scope: "global", tool: knownTool, label: `~/.kb/${knownTool}` });
    } else {
      for (const t of listInitializedToolKbs()) {
        out.push({ scope: "global", tool: t, label: `~/.kb/${t}` });
      }
    }
  }
  return out;
}

export function runInject(opts: InjectOptions = {}): { text: string; copied: boolean } {
  const targets = resolveTargets(opts);
  const projectName = opts.cwd ? opts.cwd.split("/").pop() : "this project";
  const toolLabel = opts.tool ? `(${opts.tool}) ` : "";

  // --- Task roll-up mode. ---
  if (opts.task) {
    const sections: string[] = ["## Previous Session Context", ""];
    sections.push(`You were working on **${projectName}**. ${toolLabel}Here's the task roll-up:`, "");
    const slug = opts.task.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    let any = false;
    for (const t of targets) {
      if (!isKbInitialized(t.scope, opts.cwd, t.tool)) continue;
      const body = readWikiFile(t.scope, `tasks/${slug}.md`, opts.cwd, t.tool);
      if (body.trim()) {
        sections.push(`### ${t.label} task roll-up`);
        const filtered = opts.topic ? filterToTopic(body, opts.topic) : body;
        sections.push("", filtered.trim(), "");
        any = true;
      }
    }
    if (!any) {
      sections.push(
        `No task roll-up found for \`${opts.task}\`. Captures tagged with \`--task ${opts.task}\` will populate it.`,
        "",
      );
    }
    return finish(sections, opts);
  }

  // --- Standard mode. ---
  const sections: string[] = ["## Previous Session Context", ""];
  sections.push(`You were working on **${projectName}**. ${toolLabel}Here's the current memory state:`, "");
  let anyContent = false;

  for (const t of targets) {
    if (!isKbInitialized(t.scope, opts.cwd, t.tool)) continue;

    if (opts.last) {
      const session = latestSessionFile(t.scope, opts.cwd, t.tool);
      if (!session) continue;
      if (opts.tool && !sessionFileMatchesTool(session.relPath, opts.tool)) continue;
      const body = readWikiFile(t.scope, session.relPath, opts.cwd, t.tool);
      const filtered = opts.topic ? filterToTopic(body, opts.topic) : body;
      if (filtered.trim()) {
        sections.push(`### Latest session (${t.label})`);
        sections.push("", filtered.trim(), "");
        anyContent = true;
      }
      continue;
    }

    sections.push(`### ${t.label}`);
    for (const rel of SECTION_ORDER) {
      const body = readWikiFile(t.scope, rel, opts.cwd, t.tool);
      const filtered = opts.topic ? filterToTopic(body, opts.topic) : body;
      if (filtered.trim()) {
        sections.push(`#### ${headingFor(rel)}`);
        sections.push("", filtered.trim(), "");
        anyContent = true;
      }
    }
    const extra = listWikiFiles(t.scope, opts.cwd, t.tool).filter((f) => {
      if (f.relPath.startsWith("sessions/")) return false;
      if (f.relPath === "index.md") return false;
      if (SECTION_ORDER.includes(f.relPath)) return false;
      if (opts.tool && !sessionFileMatchesTool(f.relPath, opts.tool)) return false;
      return true;
    });
    for (const f of extra) {
      const body = readWikiFile(t.scope, f.relPath, opts.cwd, t.tool);
      const filtered = opts.topic ? filterToTopic(body, opts.topic) : body;
      if (filtered.trim()) {
        sections.push(`#### ${f.relPath.replace(/\.md$/, "")}`);
        sections.push("", filtered.trim(), "");
        anyContent = true;
      }
    }
  }

  if (!anyContent) {
    return {
      text:
        `## Previous Session Context\n\nNo captured context found for ${projectName}.\n` +
        `Run \`kb capture\` after a session to build the knowledge base.\n`,
      copied: false,
    };
  }

  return finish(sections, opts);
}

function finish(sections: string[], opts: InjectOptions): { text: string; copied: boolean } {
  const text = sections.join("\n").trim() + "\n";
  const copied = opts.copy ? copyToClipboard(text) : false;
  return { text, copied };
}

/** Match the `source:` tag embedded in a project-KB session filename. */
function sessionFileMatchesTool(relPath: string, tool: string): boolean {
  const t = tool.toLowerCase();
  return relPath.toLowerCase().includes(`.${t}.`) || relPath.toLowerCase().startsWith(`${t}/`);
}

function filterToTopic(md: string, topic: string): string {
  const needle = topic.toLowerCase();
  const lines = md.split("\n");
  const out: string[] = [];
  let keepHeading: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,4}\s+/.test(trimmed)) {
      if (trimmed.toLowerCase().includes(needle)) {
        keepHeading = trimmed;
        out.push(line);
      } else {
        keepHeading = null;
      }
      continue;
    }
    if (trimmed.toLowerCase().includes(needle)) {
      if (keepHeading) out.push(line);
      else out.push(line);
    }
  }
  return out.join("\n");
}

function headingFor(rel: string): string {
  const map: Record<string, string> = {
    "project-state.md": "Project Overview",
    "decisions-log.md": "Key Decisions Made",
    "architecture.md": "Architecture",
    "patterns.md": "Established Patterns",
    "bugs-and-fixes.md": "Recent Bugs & Fixes",
    "open-questions.md": "Open Questions",
  };
  return map[rel] ?? rel.replace(/\.md$/, "");
}

function copyToClipboard(text: string): boolean {
  const cmds = ["wl-copy", "xclip -selection clipboard", "xsel --clipboard --input", "pbcopy"];
  for (const cmd of cmds) {
    try {
      execSync(`${cmd}`, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}
