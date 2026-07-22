/**
 * commands/export.ts — `kb export` archives the knowledge base as a tar.gz file.
 *
 *   kb export                       → project KB to ./kb-export-<date>.tar.gz
 *   kb export /path/to/backup.tar.gz
 *   kb export --global              → every initialized per-tool global KB
 *   kb export --global --tool codex → Codex's global KB only
 *   kb export --format json         (future)
 */
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Scope, SourceTool } from "../types.js";
import { isKbInitialized, listInitializedToolKbs, rootFor } from "../storage.js";

export interface ExportOptions {
  global?: boolean;
  tool?: string;
  output?: string;
  format?: string;
  cwd?: string;
}

export interface ExportResult {
  path: string;
  bytes: number;
  scope: Scope;
  summary: string;
}

export function runExport(opts: ExportOptions = {}): ExportResult {
  const cwd = opts.cwd ?? process.cwd();
  const fmt = opts.format ?? "tar.gz";
  if (fmt !== "tar.gz") {
    throw new Error(`Unsupported export format: ${fmt}. Only "tar.gz" is supported.`);
  }

  const tool = opts.tool as SourceTool | undefined;
  const knownTool = tool && tool !== "unattributed" ? tool : undefined;

  if (!opts.global) {
    // Project KB only.
    if (!isKbInitialized("project", cwd)) {
      throw new Error("Project KB not initialized. Run `kb init` first.");
    }
    const root = rootFor("project", cwd);
    return writeArchive(root, cwd, opts.output, "project KB");
  }

  // Global: pick the per-tool KB(s) to archive.
  const tools: SourceTool[] = knownTool ? [knownTool] : listInitializedToolKbs();
  if (tools.length === 0) {
    throw new Error("No per-tool global KBs initialized. Run `kb init --global` first.");
  }
  // Archive each tool's KB as its own tarball (sizes add up fast).
  let lastResult: ExportResult | null = null;
  const summaries: string[] = [];
  let totalBytes = 0;
  for (const t of tools) {
    if (!isKbInitialized("global", undefined, t)) {
      summaries.push(`~/.kb/${t}: not initialized, skipped.`);
      continue;
    }
    const root = rootFor("global", undefined, t);
    const suffix = opts.output ? "" : `-${t}`;
    const out = opts.output && tools.length === 1
      ? opts.output
      : opts.output
        ? `${basename(opts.output, ".tar.gz")}${suffix}.tar.gz`
        : undefined;
    const result = writeArchive(root, cwd, out, `~/.kb/${t}`);
    lastResult = result;
    totalBytes += result.bytes;
    summaries.push(result.summary + "\n");
  }
  const summary = summaries.join("\n").trim() + (tools.length > 1 ? `\nTotal: ${formatBytes(totalBytes)} across ${tools.length} KBs.` : "");
  return lastResult ?? { path: "", bytes: 0, scope: "global", summary };
}

function writeArchive(root: string, cwd: string, outputOpt: string | undefined, label: string): ExportResult {
  const dt = datestamp();
  const defaultName = label.startsWith("~/.kb/")
    ? `kb-${label.split("/").pop()}-export-${dt}.tar.gz`
    : `kb-export-${dt}.tar.gz`;
  const output = outputOpt ? resolve(outputOpt) : resolve(join(cwd, defaultName));
  const dirName = basename(root);
  const parentDir = dirname(root);
  execSync(`tar -czf "${output}" -C "${parentDir}" "${dirName}"`, { stdio: "ignore" });
  const bytes = existsSync(output) ? statSync(output).size : 0;
  const summary = `Exported ${label} to ${output} (${formatBytes(bytes)}).`;
  const scope: Scope = label === "project KB" ? "project" : "global";
  return { path: output, bytes, scope, summary };
}

function datestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
