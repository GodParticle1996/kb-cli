/**
 * watcher/daemon.ts — background watcher that monitors AI tool session files
 * and triggers a capture whenever a session file changes.
 *
 * Uses a pidfile under ~/.kb/cache/ to track the running daemon, supporting
 * `kb start`, `kb stop`, and `kb status`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import { cacheDir } from "../storage.js";
import { SESSION_LOCATORS, SessionFile, KNOWN_TOOLS } from "./providers.js";

const PIDFILE = "watcher.pid";

function pidfilePath(): string {
  return join(cacheDir(), PIDFILE);
}

export interface WatcherStatus {
  running: boolean;
  pid: number | null;
  watching: string[];
}

/** Check whether the watcher daemon is currently running. */
export function watcherStatus(): WatcherStatus {
  const p = pidfilePath();
  if (!existsSync(p)) return { running: false, pid: null, watching: [] };
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as {
      pid: number;
      watching: string[];
    };
    if (!isAlive(data.pid)) {
      return { running: false, pid: null, watching: [] };
    }
    return { running: true, pid: data.pid, watching: data.watching };
  } catch {
    return { running: false, pid: null, watching: [] };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the running watcher daemon, if any. Returns true if it was stopped. */
export function stopWatcher(): boolean {
  const status = watcherStatus();
  if (!status.running || !status.pid) return false;
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // ignore
  }
  try {
    rmSync(pidfilePath());
  } catch {
    // ignore
  }
  return true;
}

/** Resolve the directories to watch for the given tools + cwd. */
function watchDirs(tools: string[], cwd: string): string[] {
  const dirs: string[] = [];
  if (tools.includes("claude")) {
    dirs.push(join(process.env.HOME ?? "", ".claude", "projects"));
  }
  if (tools.includes("cline")) {
    dirs.push(
      join(
        process.env.HOME ?? "",
        ".config",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks",
      ),
    );
  }
  if (tools.includes("kimi") || tools.includes("kimchi")) {
    dirs.push(join(cwd, ".kimchi", "sessions"));
  }
  if (tools.includes("opencode")) {
    dirs.push(join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share"), "opencode", "sessions"));
  }
  if (tools.includes("codex")) {
    dirs.push(join(cwd, ".codex", "sessions"));
  }
  return dirs.filter((d) => existsSync(d));
}

/** Expand "auto"/"kimchi" into the concrete set of tools installed on disk. */
function resolveToolList(tools: string[], cwd: string): string[] {
  if (!tools.includes("auto")) {
    // Normalize "kimchi" -> "kimi" for downstream routing.
    return tools.map((t) => (t === "kimchi" ? "kimi" : t));
  }
  // Auto: probe each known tool's session dir; keep those that exist.
  const detected: string[] = [];
  for (const t of KNOWN_TOOLS) {
    const probe =
      t === "claude" ? join(process.env.HOME ?? "", ".claude", "projects") :
      t === "cline" ? join(process.env.HOME ?? "", ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks") :
      t === "kimi" ? join(cwd, ".kimchi", "sessions") :
      t === "opencode" ? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share"), "opencode", "sessions") :
      t === "codex" ? join(cwd, ".codex", "sessions") : null;
    if (probe && existsSync(probe)) detected.push(t);
  }
  // Always also accept "kimchi" dir under cwd.
  return detected;
}

/**
 * Start the watcher daemon as a detached child process running the CLI in
 * watch-worker mode. Returns the spawned pid.
 */
export function startWatcher(tools: string[]): number | null {
  const status = watcherStatus();
  if (status.running) {
    return status.pid;
  }
  mkdirSync(cacheDir(), { recursive: true });
  const resolved = tools.map((t) => (t === "kimchi" ? "kimi" : t));
  // Re-invoke this CLI in worker mode.
  const child = spawn(
    process.execPath,
    [process.argv[1], "capture", "--watch-worker", "--tools", resolved.join(",")],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, KB_WATCH_TOOLS: resolved.join(",") },
    },
  );
  child.unref();
  return child.pid ?? null;
}

/**
 * Capture delta passed from the watcher to the capture handler. `isNew` is true
 * the first time the worker sees this session file (or after it switches to a
 * different session); in that case `text` contains the full normalized
 * transcript. When `isNew` is false, `text` contains only the newly-appended
 * tail of the session file (with a small overlap for context).
 */
export interface CaptureDelta {
  isNew: boolean;
  text: string;
}

/**
 * Watch worker main loop. Watches the tool session dirs and, on change,
 * locates the latest session for the current cwd. The actual capture runs
 * in-process here. The worker tracks the byte size of the last session file
 * it captured so subsequent saves only process the newly-appended tail —
 * without this the cost of each capture grows linearly with session length.
 */
export async function runWatcherWorker(
  tools: string[],
  onCapture: (session: SessionFile, delta: CaptureDelta) => Promise<void>,
): Promise<void> {
  const cwd = process.cwd();
  const resolved = resolveToolList(tools, cwd);
  writeFileSync(
    pidfilePath(),
    JSON.stringify({ pid: process.pid, watching: resolved }),
    "utf8",
  );

  const dirs = watchDirs(resolved, cwd);
  if (dirs.length === 0) {
    process.stderr.write(`kb: no session directories found for tools: ${resolved.join(", ")}\n`);
  } else {
    process.stderr.write(`kb: watcher watching: ${resolved.join(", ")}\n`);
  }

  const OVERLAP = 512;
  let last: { path: string; size: number } | null = null;

  let debounce: NodeJS.Timeout | null = null;
  const trigger = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const latest = pickLatest(resolved, cwd);
      if (!latest) return;
      let isNew = true;
      let text: string;
      try {
        const size = statSync(latest.path).size;
        if (last && last.path === latest.path) {
          if (size <= last.size) return;
          isNew = false;
          const buf = readFileSync(latest.path);
          const start = Math.max(0, last.size - OVERLAP);
          text = buf.subarray(start).toString("utf8");
        } else {
          text = latest.read();
        }
        last = { path: latest.path, size };
      } catch (err) {
        process.stderr.write(`kb: watcher stat/read failed: ${String(err)}\n`);
        return;
      }
      try {
        await onCapture(latest, { isNew, text });
      } catch (err) {
        process.stderr.write(`kb: watcher capture failed: ${String(err)}\n`);
      }
    }, 2000);
  };

  const watcher = chokidar.watch(dirs, {
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on("add", trigger);
  watcher.on("change", trigger);

  // Keep alive until killed.
  process.on("SIGTERM", () => {
    void watcher.close();
    try {
      rmSync(pidfilePath());
    } catch {
      // ignore
    }
    process.exit(0);
  });
}

function pickLatest(tools: string[], cwd: string): SessionFile | null {
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
