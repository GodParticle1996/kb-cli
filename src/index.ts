#!/usr/bin/env node
/**
 * kb — Central Memory for AI coding tools.
 *
 * Watches session files produced by Claude / Kimi / OpenCode / Codex / Cline,
 * derives a structured understanding of each session, and stores it in per-tool
 * knowledge bases so any future session can restore context.
 *
 * Usage: `kb <command> [options]`. See `kb --help`.
 */
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the kb-cli package directory (works regardless of cwd),
// then also try cwd for additional project-specific keys.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgEnv = resolve(__dirname, "..", ".env");
dotenv.config({ path: pkgEnv });
dotenv.config(); // cwd .env for extra keys (doesn't overwrite already-set vars)

import { stdin } from "node:process";
import { Command } from "commander";
import { loadEffectiveConfig } from "./config.js";
import { runInit, initSummary } from "./commands/init.js";
import { runCaptureCommand } from "./commands/capture.js";
import type { CaptureOptions } from "./commands/capture.js";
import { runInject } from "./commands/inject.js";
import { runRecall, formatRecallHits } from "./commands/recall.js";
import { runLog } from "./commands/log.js";
import { runStatus } from "./commands/status.js";
import { runReview } from "./commands/review.js";
import { runExport } from "./commands/export.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";

const program = new Command();

program
  .name("kb")
  .description("Central Memory for AI coding tools — capture & restore session context")
  .version("0.2.0");

// --- kb init ---
program
  .command("init")
  .description("Initialize a knowledge base (./kb or all per-tool global KBs with --global)")
  .option("--global", "Initialize the per-tool global KBs at ~/.kb/<tool>/")
  .option("--tool <name>", "With --global, initialize just one tool's KB (claude|kimi|opencode|codex|cline)")
  .action((opts: { global?: boolean; tool?: string }) => {
    const result = runInit({ global: opts.global, tool: opts.tool });
    console.log(initSummary(result));
  });

// --- kb capture ---
program
  .command("capture")
  .description("Capture a session transcript into the knowledge base")
  .option("--global", "Capture to the per-tool global KB only (skip the project KB)")
  .option("--file <path>", "Read session text from a file")
  .option("--from <tool>", "Auto-find the latest session for a tool (claude|cline|kimi|opencode|codex|auto)")
  .option("--tool <name>", "Explicitly tag the capture with a source tool (use with stdin/--file)")
  .option("--task <slug>", "Tag the capture with a task slug (joins wiki/tasks/<slug>.md)")
  .option("--label <text>", "Custom session label")
  .option("--watch-worker", "Run the watcher loop in-process (internal; used by `kb start`)")
  .action(async (opts: Omit<CaptureOptions, "config" | "stdinText">) => {
    const config = loadEffectiveConfig();
    const isInteractive = process.stdin.isTTY === true;
    let stdinText: string | undefined;
    if (!opts.file && !opts.from && !opts.watchWorker) {
      if (isInteractive) {
        console.error(
          "kb: no input. Pipe a transcript via stdin, e.g. `cat session.log | kb capture`, or use --file / --from <tool>.",
        );
        process.exitCode = 1;
        return;
      }
      stdinText = await readStdin();
    }
    await runCaptureCommand({ ...opts, stdinText, config });
  });

// --- kb start ---
program
  .command("start")
  .description("Start the background watcher daemon (auto-detects all tools)")
  .option("--tools <list>", "Comma-separated tools to watch (claude,cline,kimi,opencode,codex,auto)")
  .action((opts: { tools?: string }) => {
    const config = loadEffectiveConfig();
    console.log(runStart({ tools: opts.tools, config }));
  });

// --- kb stop ---
program
  .command("stop")
  .description("Stop the background watcher daemon")
  .action(() => {
    console.log(runStop());
  });

// --- kb inject ---
program
  .command("inject")
  .description("Generate a context injection prompt from the KB")
  .option("--global", "Also include global KB context")
  .option("--tool <name>", "Filter to one tool's memory (claude|kimi|opencode|codex|cline)")
  .option("--task <slug>", "Render the cross-tool roll-up for one task")
  .option("--topic <text>", "Filter for a specific topic")
  .option("--last", "Only context from the most recent session")
  .option("--copy", "Copy output to clipboard")
  .action((opts: { global?: boolean; tool?: string; task?: string; topic?: string; last?: boolean; copy?: boolean }) => {
    const { text, copied } = runInject(opts);
    process.stdout.write(text);
    if (opts.copy) {
      console.error(copied ? "kb: copied to clipboard." : "kb: no clipboard tool available; printed above.");
    }
  });

// --- kb recall ---
program
  .command("recall <query>")
  .description("Semantic search across the knowledge base")
  .option("--project", "Search project KB only")
  .option("--global", "Search global KB only")
  .option("--tool <name>", "Limit to one tool's KB (claude|kimi|opencode|codex|cline)")
  .option("--max <n>", "Max results", "5")
  .action(async (query: string, opts: { project?: boolean; global?: boolean; tool?: string; max?: string }) => {
    const config = loadEffectiveConfig();
    const max = opts.max ? Number(opts.max) : 5;
    const hits = await runRecall({ query, project: opts.project, global: opts.global, tool: opts.tool, max, config });
    console.log(formatRecallHits(hits));
  });

// --- kb log ---
program
  .command("log <message>")
  .description("Manually log a fact to the KB")
  .option("--category <cat>", "Fact category (decision|architecture|pattern|bugfix|state|open-question|note)")
  .option("--global", "Log to the global KB")
  .option("--tool <name>", "Attribute the fact to a tool (claude|kimi|opencode|codex|cline|unattributed)")
  .option("--task <slug>", "Tag the entry with a task slug")
  .option("--rationale <text>", "Rationale or supporting detail")
  .action(async (message: string, opts: { category?: string; global?: boolean; tool?: string; task?: string; rationale?: string }) => {
    const config = loadEffectiveConfig();
    const out = await runLog({ message, category: opts.category, global: opts.global, tool: opts.tool, task: opts.task, rationale: opts.rationale, config });
    console.log(out);
  });

// --- kb status ---
program
  .command("status")
  .description("Show knowledge base stats and watcher state")
  .option("--verbose", "Per-file breakdown")
  .action(async (opts: { verbose?: boolean }) => {
    const config = loadEffectiveConfig();
    const out = await runStatus({ verbose: opts.verbose, config });
    process.stdout.write(out);
  });

// --- kb review ---
program
  .command("review")
  .description("Show recent changes and flagged contradictions")
  .option("--since <dur>", "Time window, e.g. 3d, 12h, 2w", "7d")
  .option("--global", "Review every initialized per-tool global KB")
  .option("--tool <name>", "With --global, review just one tool's KB")
  .action(async (opts: { since?: string; global?: boolean; tool?: string }) => {
    const config = loadEffectiveConfig();
    const out = await runReview({ since: opts.since, global: opts.global, tool: opts.tool, config });
    process.stdout.write(out);
  });

// --- kb export ---
program
  .command("export [path]")
  .description("Export the knowledge base as a tar.gz archive")
  .option("--global", "Export every initialized per-tool global KB")
  .option("--tool <name>", "With --global, export just one tool's KB")
  .option("--format <fmt>", "Export format (tar.gz only for now)", "tar.gz")
  .action((output: string | undefined, opts: { global?: boolean; tool?: string; format?: string }) => {
    try {
      const result = runExport({ global: opts.global, tool: opts.tool, output, format: opts.format });
      console.log(`kb: ${result.summary}`);
    } catch (err) {
      console.error(`kb: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// --- kb completion ---
program
  .command("completion")
  .description("Generate shell completion script")
  .option("--bash", "Output bash completion script")
  .option("--zsh", "Output zsh completion script")
  .action((opts: { bash?: boolean; zsh?: boolean }) => {
    const shell = opts.zsh ? "zsh" : "bash";
    const commands = program.commands.map((c) => c.name());
    if (shell === "zsh") {
      console.log(zshCompletion(commands));
    } else {
      console.log(bashCompletion(commands));
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`kb: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

/** Read all of stdin as a UTF-8 string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("close", () => resolve(data));
  });
}

function bashCompletion(commands: string[]): string {
  return `# kb bash completion — add to ~/.bashrc:
#   source <(kb completion)
_kb_completion() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local prev=\${COMP_WORDS[COMP_CWORD-1]}
  local cmds="${commands.join(" ")}"

  if [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") )
  else
    case "\$prev" in
      capture)
        COMPREPLY=( \$(compgen -W "--global --file --from --tool --task --label" -- "\$cur") ) ;;
      inject)
        COMPREPLY=( \$(compgen -W "--global --tool --task --topic --last --copy" -- "\$cur") ) ;;
      init)
        COMPREPLY=( \$(compgen -W "--global --tool" -- "\$cur") ) ;;
      recall)
        COMPREPLY=( \$(compgen -W "--project --global --tool --max" -- "\$cur") ) ;;
      log)
        COMPREPLY=( \$(compgen -W "--category --global --tool --task --rationale" -- "\$cur") ) ;;
      status)
        COMPREPLY=( \$(compgen -W "--verbose" -- "\$cur") ) ;;
      review)
        COMPREPLY=( \$(compgen -W "--since --global --tool" -- "\$cur") ) ;;
      export)
        COMPREPLY=( \$(compgen -W "--global --tool --format" -- "\$cur") ) ;;
      start)
        COMPREPLY=( \$(compgen -W "--tools" -- "\$cur") ) ;;
      stop)
        COMPREPLY=( \$(compgen -W "" -- "\$cur") ) ;;
      completion)
        COMPREPLY=( \$(compgen -W "--bash --zsh" -- "\$cur") ) ;;
      *)
        COMPREPLY=() ;;
    esac
  fi
}
complete -F _kb_completion kb
`;
}

function zshCompletion(commands: string[]): string {
  return `# kb zsh completion — add to ~/.zshrc:
#   source <(kb completion --zsh)
#compdef kb

_kb_commands() {
  local -a cmds
  cmds=(${commands.map((c) => `"${c}:"`).join("\n        ")})
  _describe 'command' cmds
}

_kb_capture_opts() { _arguments '--global' '--file[read from file]:file:_files' '--from[tool]:tool:(claude cline kimi opencode codex auto)' '--tool[source tool]:tool:(claude kimi opencode codex cline unattributed)' '--task[task slug]:task:' '--label[label]:label:' }
_kb_init_opts() { _arguments '--global' '--tool[tool]:tool:(claude kimi opencode codex cline)' }
_kb_inject_opts() { _arguments '--global' '--tool[tool]:tool:(claude kimi opencode codex cline)' '--task[task slug]:task:' '--topic[topic]:topic:' '--last' '--copy' }
_kb_recall_opts() { _arguments '--project' '--global' '--tool[tool]:tool:(claude kimi opencode codex cline)' '--max[max results]:max:' }
_kb_log_opts() { _arguments '--category[category]:cat:(decision architecture pattern bugfix file-change state open-question note)' '--global' '--tool[tool]:tool:(claude kimi opencode codex cline unattributed)' '--task[task slug]:task:' '--rationale[rationale]:text:' }
_kb_status_opts() { _arguments '--verbose' }
_kb_review_opts() { _arguments '--since[duration]:dur:' '--global' '--tool[tool]:tool:(claude kimi opencode codex cline)' }
_kb_export_opts() { _arguments '--global' '--tool[tool]:tool:(claude kimi opencode codex cline)' '--format[format]:fmt:' }
_kb_start_opts() { _arguments '--tools[tools]:tools:(claude cline kimi opencode codex auto)' }
_kb_stop_opts() { _arguments }
_kb_completion_opts() { _arguments '--bash' '--zsh' }

_kb() {
  local curcontext="\$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '1: :_kb_commands' \\
    '*:: :->args'

  case "\$state" in
    args)
      case "\$words[1]" in
        capture) _kb_capture_opts ;;
        init) _kb_init_opts ;;
        inject) _kb_inject_opts ;;
        recall) _kb_recall_opts ;;
        log) _kb_log_opts ;;
        status) _kb_status_opts ;;
        review) _kb_review_opts ;;
        export) _kb_export_opts ;;
        start) _kb_start_opts ;;
        stop) _kb_stop_opts ;;
        completion) _kb_completion_opts ;;
      esac
      ;;
  esac
}
`;
}
