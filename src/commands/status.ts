/**
 * commands/status.ts — `kb status` prints KB stats for the project KB and each
 * initialized per-tool global KB (~/.kb/<tool>/), plus the watcher state.
 *
 *   kb status            summary across project + every per-tool global KB
 *   kb status --verbose  per-file breakdown
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig, Scope, SourceTool } from "../types.js";
import {
  isKbInitialized,
  listInitializedToolKbs,
  projectRoot,
  toolRoot,
  vectorsDir,
} from "../storage.js";
import { countFacts, listWikiFiles, latestSessionFile } from "../wiki/engine.js";
import { countVectors } from "../vectors/store.js";

export interface StatusOptions {
  verbose?: boolean;
  config: KbConfig;
  cwd?: string;
}

interface StatusTarget {
  scope: Scope;
  tool?: SourceTool;
  root: string;
  label: string;
}

export async function runStatus(opts: StatusOptions): Promise<string> {
  const lines: string[] = [];
  const targets: StatusTarget[] = [
    { scope: "project", root: projectRoot(opts.cwd ?? process.cwd()), label: "Project KB" },
  ];
  for (const t of listInitializedToolKbs()) {
    targets.push({ scope: "global", tool: t, root: toolRoot(t), label: `~/.kb/${t}` });
  }

  for (const t of targets) {
    const initialized = isKbInitialized(t.scope, opts.cwd, t.tool);
    lines.push(`${t.label}: ${t.root}`);
    if (!initialized) {
      const initCmd = t.scope === "global" ? "kb init --global" : "kb init";
      lines.push(`  (not initialized — run \`${initCmd}\`)`);
      lines.push("");
      continue;
    }
    const files = listWikiFiles(t.scope, opts.cwd, t.tool);
    const facts = countFacts(t.scope, opts.cwd, t.tool);
    const session = latestSessionFile(t.scope, opts.cwd, t.tool);
    const lastCapture = session ? new Date(session.mtime).toLocaleString() : "—";
    let vecCount = 0;
    try {
      vecCount = await countVectors(t.scope, opts.cwd, t.tool);
    } catch {
      vecCount = 0;
    }
    const vecSize = vectorStoreSize(t.scope, opts.cwd, t.tool);
    lines.push(`  Wiki files:     ${files.length}`);
    lines.push(`  Total facts:    ${facts}`);
    lines.push(`  Last capture:   ${lastCapture}`);
    lines.push(`  Vector store:   ${vecSize}${vecCount > 0 ? ` / ${vecCount} embeddings` : ""}`);
    if (opts.verbose) {
      for (const f of files) {
        lines.push(`    - ${f.relPath} (${f.bytes} B)`);
      }
    }
    lines.push("");
  }

  // Provider status line.
  const { buildProviders, getProvider } = await import("../providers/index.js");
  const providers = buildProviders(opts.config);
  const { provider, available } = getProvider(opts.config, providers);
  if (provider) {
    lines.push(`Extraction provider: ${provider.label}`);
  } else {
    lines.push(
      `Extraction provider: none configured (heuristic fallback). Available keys: ${available.length ? available.join(", ") : "none"}.`,
    );
  }
  return lines.join("\n").trim() + "\n";
}

function vectorStoreSize(scope: Scope, cwd?: string, tool?: SourceTool): string {
  const dir = vectorsDir(scope, cwd, tool);
  if (!existsSync(dir)) return "0 B";
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      total += statSync(join(dir, entry)).size;
    }
  } catch {
    // ignore
  }
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
  return `${(total / 1024 / 1024).toFixed(1)} MB`;
}
