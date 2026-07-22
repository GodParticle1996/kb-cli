/**
 * commands/start.ts — `kb start` launches the background watcher daemon, which
 * auto-detects installed AI coding tools and captures their sessions into the
 * KBs. Replaces the old `kb capture --watch` flag.
 *
 *   kb start                   auto-detect every installed tool and watch all
 *   kb start --tools claude,kimi   restrict to a subset
 */
import type { KbConfig } from "../types.js";
import { startWatcher, watcherStatus } from "../watcher/daemon.js";

export interface StartOptions {
  tools?: string;
  config: KbConfig;
}

/** Launch the watcher daemon. Returns a human-readable status line. */
export function runStart(opts: StartOptions): string {
  const existing = watcherStatus();
  if (existing.running) {
    return `kb: watcher already running (pid ${existing.pid}), watching: ${existing.watching.join(", ")}`;
  }
  const tools =
    opts.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) ?? opts.config.watch?.providers ?? ["auto"];
  const pid = startWatcher(tools);
  return `kb: watcher started (pid ${pid ?? "?"}), tools: ${tools.join(", ")}`;
}
