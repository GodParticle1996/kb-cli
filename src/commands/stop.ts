/**
 * commands/stop.ts — `kb stop` terminates the background watcher daemon.
 * Replaces the old `kb capture --stop` flag.
 *
 *   kb stop
 */
import { stopWatcher } from "../watcher/daemon.js";

/** Stop the watcher daemon. Returns a human-readable status line. */
export function runStop(): string {
  const stopped = stopWatcher();
  return stopped ? "kb: watcher stopped." : "kb: no watcher running.";
}
