# `kb` — Central Memory for AI Coding Tools

`kb` is a **passive background memory** that every AI coding tool you use can
write to and read from. It watches the session files Claude Code, Kimchi,
OpenCode, Codex, and Cline already produce on disk, derives a structured
understanding of each session, and stores it in **per-tool knowledge bases**.
Any future session — even on a weaker model — can restore that context and
continue the task without re-teaching.

> `kb` is **not** a coding agent and never runs code. It only reads session
> transcripts and writes knowledge-base files. The previous Claude-Code-like
> REPL (`kb agent`) has been removed.

## Quick Start

```bash
cd kb-cli
npm install && npm run build
npm link                # makes `kb` available globally

export GROQ_API_KEY='...'        # or any provider key (see below)
kb init                 # initialize KB in current project
kb start                # start the background watcher (auto-detects all tools)
```

That's it. Keep coding with whatever AI tools you normally use. `kb` silently
captures each session into the right KB. When you start a new session and want
to resume:

```bash
kb inject --last         # paste the latest session's memory into the new chat
kb inject --task refactor-auth   # the full cross-tool roll-up for one task
```

---

## The Memory Model

Every captured session produces two artifacts in its tool's KB:

1. **A structured task-summary file** — `wiki/sessions/<timestamp>-<slug>.<tool>.md`
   with fixed sections: **Task / Goal**, **Files Traversed** (with `file:symbol`
   references and the *why* of each traversal), **Changes Made** (file:symbol +
   reason + diff/commit), **Final Result**, **Open Threads**.
2. **Rolling topic-merge files** — `wiki/decisions-log.md` and
   `wiki/file-changes.md`, lightly appended on every capture so durable
   decisions accumulate across sessions (contradictions are flagged).

When a capture is tagged with `--task <slug>`, it also appends to
`wiki/tasks/<slug>.md` — the **resume document** that fuses every session
(any tool) that worked on that task. `kb inject --task <slug>` returns it.

## The Dual KB Layout

```
~/.kb/                ← per-tool global KBs (every session, every project)
  ├── claude/         ├── kimi/   ├── opencode/   ├── codex/   ├── cline/
  │     └── wiki/{sessions,tasks,decisions-log.md,file-changes.md}
  ├── config.json
  └── cache/

./kb/                 ← project KB (this codebase, every tool's work, tagged source:)
  └── wiki/
      ├── sessions/<ts>-<slug>.<tool>.md
      ├── tasks/<slug>.md          ← cross-tool roll-up for one task
      ├── decisions-log.md
      └── file-changes.md
```

Per-tool global KBs answer "what did *Claude* figure out?"; the project KB
answers "what is the *whole* state of this codebase across every tool?" Both
are filled by the same watcher.

---

## Commands

### `kb start` / `kb stop` / `kb status` — the watcher

```bash
kb start                       # auto-detect every installed tool and watch all
kb start --tools claude,kimi   # narrow to a subset
kb stop
kb status                      # is it running? which tools? last capture?
```

The watcher is the **default** way to use `kb` — run it once and forget.

### `kb capture` — manual / one-shot capture

```bash
kb capture                           # read a transcript from stdin
kb capture --tool claude             # tag an stdin capture with a source tool
kb capture --from claude             # capture Claude's latest session now
kb capture --from auto               # latest session across all detected tools
kb capture --file session.txt
kb capture --task refactor-auth      # tag the capture with a task slug
kb capture --global                  # write only to ~/.kb/<tool>/ (skip ./kb/)
```

`--from <tool>` auto-finds the latest session on disk; `--tool <name>` lets you
attribute an stdin/file transcript when kb can't infer it. `--task <slug>` is
what makes the capture join `wiki/tasks/<slug>.md` across tools and scopes.

### `kb inject` — restore memory into a new session

```bash
kb inject                       # project KB primer: latest work across all tools
kb inject --tool claude         # only Claude's memory (project + ~/.kb/claude)
kb inject --global              # all per-tool global KBs (~/.kb/<tool>/)
kb inject --task refactor-auth  # the cross-tool roll-up for one task
kb inject --last                # only the most recent session summary
kb inject --topic "auth"        # filter for a specific topic
kb inject --copy                # copy to clipboard
```

`inject` calls **no LLM** — it just reads the wiki and prints text. Works with
any tool, any provider, any model.

### `kb recall` — semantic search

```bash
kb recall "auth middleware"
kb recall --tool claude "decisions"     # Claude's KB (project + ~/.kb/claude)
kb recall --global "design patterns"     # every per-tool global KB
kb recall --project "error handling"    # only the project KB
kb recall --max 10 "race condition"
```

### `kb log` — manually log a fact

```bash
kb log "Decided to use Redis for session caching"
kb log --category decision "Switched from Jest to Vitest"
kb log --tool claude --task refactor-auth "spotted race in refreshToken"
kb log --global "Learned that pgvector supports HNSW indexes"   # writes to ~/.kb/<tool>/
```

Categories: `decision`, `architecture`, `pattern`, `bugfix`, `file-change`,
`state`, `open-question`, `note`.

### `kb init` / `kb status` / `kb review` / `kb export`

```bash
kb init --global                # create every per-tool global KB at once
kb init --global --tool codex   # create just Codex's KB
kb status                       # project KB + every per-tool global KB
kb status --verbose
kb review --global --since 3d   # recent changes across every per-tool KB
kb review --global --tool codex # just Codex's global KB
kb export --global               # archive every per-tool global KB as its own .tar.gz
kb export --global --tool codex  # archive just Codex's KB
```

---

## Session File Locations (auto-detected)

| Tool | Path probed | Format |
|------|-------------|--------|
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/*.jsonl` | JSONL |
| **Kimchi** | `<cwd>/.kimchi/sessions/*.jsonl` | JSONL |
| **OpenCode** | `~/.local/share/opencode/sessions/*.jsonl` *(confirm on install)* | JSONL |
| **Codex** | `~/.codex/sessions/*.jsonl` *(confirm on install)* | JSONL |
| **Cline** | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/api_conversation_history.json` | JSON |

`kb start` silently skips any tool that isn't installed on this machine.

---

## Providers

The extractor uses whichever API key you have. `kb` auto-detects (cheapest/fastest first):
Groq → Gemini → OpenAI → OpenAI-compat → Anthropic → Cloudflare → NVIDIA.

| Provider | Key Env Var | Default model |
|----------|-----------|---------------|
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| **Gemini** | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-1.5-flash` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o-mini` |
| **OpenAI-compat** | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | `gpt-4o-mini` |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-3-5-haiku-20241022` |
| **Cloudflare** | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `@cf/zai-org/glm-5.2` |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | `z-ai/glm-5.2` |

`inject`, `recall`, `status`, `review`, and `log` use **no** LLM — pure file
reads. Token cost is paid once, at capture time.

---

## Configuration

### Global: `~/.kb/config.json`

```json
{
  "provider": "auto",
  "models": {
    "groq": "llama-3.3-70b-versatile",
    "gemini": "gemini-1.5-flash",
    "openai": "gpt-4o-mini",
    "openai-compat": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-20241022",
    "cloudflare": "@cf/zai-org/glm-5.2",
    "nvidia": "z-ai/glm-5.2"
  },
  "embedding": { "mode": "hash", "model": "text-embedding-3-small", "dimensions": 256 },
  "autoCommit": true,
  "chunkSize": 12000,
  "reasoningEffort": "high",
  "destinations": { "project": true, "global": true },
  "watch": { "providers": ["auto"], "pollIntervalMs": 5000 }
}
```

### Per-Project overrides: `./kb/.kbconfig.json`

Same shape, merged on top. Lets a repo pin a stronger extractor model or disable
global writing for sensitive projects.

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `"auto"` | Active extractor provider or `"auto"` |
| `models.<provider>` | varies | Model override per provider |
| `embedding.mode` | `"hash"` | `"hash"` (no API cost) or `"api"` (provider embeddings) |
| `autoCommit` | `true` | Auto git-commit the wiki after capture |
| `chunkSize` | `12000` | Max chars per chunk fed to the extractor |
| `reasoningEffort` | `"high"` | `low`/`medium`/`high` for the extractor on reasoning models |
| `destinations.project` | `true` | Also write captures to `./kb/` (project KB) |
| `destinations.global` | `true` | Also write captures to `~/.kb/<tool>/` (per-tool global KB) |
| `watch.providers` | `["auto"]` | Tools to watch, or `["auto"]` to auto-detect all |
| `watch.pollIntervalMs` | `5000` | Daemon poll interval |

---

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest watch
npm run dev -- <command>   # run without building
```

### Tech Stack

- **TypeScript / Node 20+** (ESM)
- **commander** — CLI framework
- **@anthropic-ai/sdk / groq-sdk / openai** — multi-provider LLM access (extractor only)
- **@lancedb/lancedb** — embedded vector store (no server)
- **simple-git** — wiki versioning
- **chokidar** — watch-mode daemon
- **vitest** — tests

### Project Structure

```
src/
├── index.ts              # CLI entry point
├── commands/             # CLI commands (no agent.ts, no map.ts, no distill.ts)
│   ├── capture.ts        # kb capture (← stdin / --from / --file / --task)
│   ├── capture-runner.ts # shared pipeline runner
│   ├── export.ts         # kb export
│   ├── init.ts           # kb init
│   ├── inject.ts         # kb inject (--tool / --task / --last / --topic)
│   ├── log.ts            # kb log (--tool / --task)
│   ├── recall.ts         # kb recall (--tool)
│   ├── review.ts         # kb review
│   └── status.ts         # kb status
├── extractor/            # Capture extraction pipeline
│   ├── pipeline.ts       # orchestrator; writes sessions/*.<tool>.md + tasks/<slug>.md
│   ├── chunker.ts
│   ├── llm-extract.ts
│   └── prompts.ts
├── providers/            # LLM provider integrations (extractor only)
├── vectors/              # LanceDB store (rows tagged with `tool`)
├── watcher/              # Background daemon + tool session locators
├── wiki/                 # Wiki engine, indexer, merger
├── config.ts
├── storage.ts
├── types.ts
├── git.ts
└── commands/ (see above)
test/
├── extractor.test.ts
├── integration.test.ts
└── wiki.test.ts
```

See `kb-cli-design-doc.md` for the full design and the rationale behind the
Central Memory reframing.

## License

MIT
