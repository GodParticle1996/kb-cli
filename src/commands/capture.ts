/**
 * commands/capture.ts — `kb capture` reads session text and runs the
 * extraction pipeline. Writes fan out across the configured destinations
 * (./kb/ project KB + ~/.kb/<tool>/ per-tool global KB) unless narrowed.
 *
 * Input sources:
 *   --file <path>          read from a file
 *   --from <tool>          auto-find latest session for a tool (claude|cline|kimi|opencode|codex|auto)
 *   (stdin)                read from piped stdin
 *
 * Flags:
 *   --global               write only to the per-tool global KB (skip ./kb/)
 *   --task <slug>          tag the capture with a task slug (joins tasks/<slug>.md)
 *   --watch-worker         internal: run the watcher loop in-process (used by `kb start`)
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { KbConfig } from "../types.js";
import { runPipeline } from "../extractor/pipeline.js";
import { buildProviders, getProvider } from "../providers/index.js";
import { findLatestSession, SESSION_LOCATORS } from "../watcher/providers.js";
import { runWatcherWorker } from "../watcher/daemon.js";
import { runCapture } from "./capture-runner.js";
import { slugify } from "../storage.js";

export interface CaptureOptions {
  global?: boolean;
  file?: string;
  from?: string;
  tool?: string;
  task?: string;
  watchWorker?: boolean;
  label?: string;
  stdinText?: string;
  config: KbConfig;
  cwd?: string;
}

/** Narrow an in-memory config so a capture only writes the requested scope. */
function narrowedConfig(config: KbConfig, globalOnly?: boolean): KbConfig {
  if (!globalOnly) return config;
  return {
    ...config,
    destinations: { project: false, global: true },
  };
}

export async function runCaptureCommand(opts: CaptureOptions): Promise<void> {
  if (opts.watchWorker) {
    const tools = (process.env.KB_WATCH_TOOLS ?? "auto")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const config = opts.config;
    await runWatcherWorker(tools, async (session, delta) => {
      const raw = delta.text;
      if (raw.trim().length === 0) return;
      const providers = buildProviders(config);
      const { provider } = getProvider(config, providers);
      const stem = basename(session.path).replace(/\.[^.]+$/, "");
      const label = opts.label ?? `${session.tool}-${slugify(stem)}`;
      const result = await runPipeline({
        raw,
        sessionLabel: label,
        tool: session.tool,
        task: opts.task,
        provider,
        config,
        cwd: opts.cwd,
        incremental: !delta.isNew,
      });
      console.log(`kb: ${result.summary}`);
    });
    return; // worker runs until killed
  }

  const config = narrowedConfig(opts.config, opts.global);

  // --- Resolve input text. ---
  let raw = "";
  let label = opts.label;
  let tool: string | undefined = opts.tool;

  if (opts.file) {
    raw = readFileSync(opts.file, "utf8");
    if (!label) label = `file-${opts.file.replace(/[^\w-]+/g, "-")}`;
  } else if (opts.from) {
    let session = null;
    if (opts.from === "auto") {
      session = findLatestSession(config.watch.providers, opts.cwd ?? process.cwd());
    } else {
      const loc = SESSION_LOCATORS[opts.from];
      if (loc) session = loc(opts.cwd ?? process.cwd());
    }
    if (!session) {
      console.error("kb: no recent session found. Use --file or pipe stdin.");
      process.exitCode = 1;
      return;
    }
    raw = session.read();
    tool = session.tool;
    if (!label) label = `${session.tool}-${new Date(session.mtime).toISOString().slice(0, 16)}`;
  } else if (opts.stdinText !== undefined) {
    raw = opts.stdinText;
    if (!label) label = `stdin-${new Date().toISOString().slice(0, 16)}`;
  } else {
    console.error(
      "kb: no input. Pipe a session transcript via stdin, or use --file / --from <tool>.",
    );
    process.exitCode = 1;
    return;
  }

  if (raw.trim().length === 0) {
    console.error("kb: input is empty; nothing to capture.");
    process.exitCode = 1;
    return;
  }

  const result = await runCapture({ raw, label, tool, task: opts.task, config, cwd: opts.cwd });
  console.log(`kb: ${result.summary}`);
  if (result.contradictions.length > 0) {
    for (const c of result.contradictions) console.log(`  ⚠️  ${c}`);
  }
  if (result.committed) console.log("  (wiki changes committed to git)");
}
