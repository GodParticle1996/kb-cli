# `kb` — Central Memory for AI Coding Tools: Design Documentation

> **Date:** July 5, 2026 (revised July 9, 2026 — "Central Memory" reframing)
> **Status:** Design phase — ready for refactor + MVP v2
> **Author:** @vibekdutta

---

## 1. The Problem

Every AI coding tool today — Claude Code, Kimchi, OpenCode, Codex, Cline — is an
**amnesiac island**. Each one:

1. **Lives in its own session file** under a different location and format.
2. **Forgets everything** between sessions unless the user manually re-teaches it.
3. **Cannot read the others' work**, so switching tools means losing every decision,
   file traversal, and fix that the previous tool produced.
4. **Burns context windows / hits rate limits**, evaporating mid-task knowledge.

When you resume a task tomorrow — possibly on a cheaper / weaker model — you start
from zero. There is no shared "what was already done, how, why, and what's left"
that any tool can read to pick up where the last one stopped.

### Core Need

A **central background memory** that silently listens to every AI coding tool you
run, derives a structured *understanding* of each task session (not just a
shallow log of messages), and writes **per-tool knowledge bases** that any model —
strong or weak — can query to recover the full logical purpose, intent, and
state of past work.

---

## 2. What `kb` Is, and What It Is Not

### 2.1 What it is

`kb` is a **Central Memory for AI models**. It runs in the background, watches
the session files that your coding tools already write to disk, and turns each
session into a durable, structured, queryable summary stored in a per-tool
knowledge base.

```
        Claude          Kimchi          OpenCode        Codex          Cline
          │                │                │              │              │
          ▼                ▼                ▼              ▼              ▼
   ~ / .claude /…   <cwd>/.kimchi/…   (tool session dirs on disk)
          │                │                │              │              │
          └────────────────┴────────────────┴──────────────┴──────────────┘
                                    │  (kb watches them all)
                                    ▼
                          ┌───────────────────────┐
                          │       kb watcher       │  (background daemon)
                          └───────────┬───────────┘
                                      ▼
            ┌──────────────────────────────────────────────┐
            │           per-tool knowledge bases            │
            │   ~/.kb/claude/   ~/.kb/kimi/   ~/.kb/opencode/   │
            │   ~/.kb/codex/    ~/.kb/cline/                   │
            │   (+ ./kb/  per-project, tagged with source)    │
            └──────────────────────────────────────────────┘
                                      ▲
                                      │  (query at any time)
            ┌──────────────────────────────────────────────┐
            │  any new model session: "what was already done?" │
            │  → kb inject --last / --task / --tool ...        │
            └──────────────────────────────────────────────┘
```

### 2.2 What it is NOT (explicitly removed)

- **Not a coding agent / REPL.** The previous `kb agent` command and the entire
  `src/agent/` module were Claude-Code-like features. They have been **deleted**.
  `kb` never executes code, never edits files, never runs commands. It only
  *reads* session transcripts and *writes* KB files.
- **Not a replacement for the coding tools.** It does not intercept API calls,
  wrap the tools, or change their behavior. It is purely a passive reader of the
  files they already produce.
- **Not interactive.** There is no chat loop, no `>` prompt, no tools, no plan /
  agent modes. The only "interaction" is one-shot CLI commands run by the user
  (or, much more commonly, run silently by the background watcher).

This is a deliberate scope reduction: every Claude-Code-like feature was a
distraction from the actual purpose. `kb` exists to be **memory**, nothing else.

---

## 3. Vision

> A lower-end model walks into a half-finished task. It runs
> `kb inject --last` (or `--task refactor-auth`). It receives a grounded primer
> that tells it: what the previous tool (Claude) was trying to do, which files
> it traversed and *why* (down to the per-symbol logic), which changes it made
> and *why* each was needed, the final result, and what threads were left open.
> The weaker model skips re-reasoning through the codebase and continues the work.

The summary must be **logical**, not just textual: it must capture *intention*
(the end goal of the task), *traversal rationale* (why each file/symbol was
checked — the chain of reasoning, not the raw search), *change rationale* (why
each edit advanced the goal), and *outcome* (did the task finish, what was left).

This lets any tool resume *any* other tool's task — even across context-window
resets, rate-limit timeouts, and provider switches.

---

## 4. Architecture

### 4.1 The Dual-Layout KB System

**Per-tool global KBs** capture everything each tool ever did (cross-project).
**Per-project KBs** capture everything done *on this codebase*, tagged with the
source tool, so the project's full logical history is queryable in one place.

```
~/.kb/                                  ← Central Memory root
├── claude/                             ← Claude's KB: every Claude session everywhere
│   ├── wiki/
│   │   ├── index.md                     ← auto-maintained TOC of all Claude sessions
│   │   ├── sessions/
│   │   │   └── 2026-07-09T14-23-auth-refactor.md   ← one structured file per captured session
│   │   ├── tasks/                       ← per-task roll-ups across multiple sessions
│   │   │   └── refactor-auth.md
│   │   ├── decisions-log.md             ← (light ~30% layer) durable cross-session decisions
│   │   └── file-changes.md             ← (light ~30% layer) durable change log + git refs
│   └── vectors/                         ← LanceDB embeddings for semantic search
├── kimi/                               ← Kimchi's KB (same structure)
├── opencode/                           ← OpenCode's KB
├── codex/                              ← Codex's KB
├── cline/                              ← Cline's KB
├── config.json                         ← provider prefs, watcher config, embedding mode
└── cache/
    └── watcher.pid                     ← watcher daemon pidfile

./kb/                                   ← Project-local KB (per git repo)
├── wiki/
│   ├── index.md                        ← TOC across all tools' work on THIS project
│   ├── sessions/                       ← session files from every tool, tagged with `source:`
│   │   └── 2026-07-09T14-23-auth-refactor.claude.md
│   ├── tasks/
│   │   └── refactor-auth.md            ← cross-tool, cross-session task roll-up
│   ├── decisions-log.md
│   └── file-changes.md
└── .kbconfig.json                      ← per-project overrides
```

**Why per-tool + project-tagged:** the user's mental model is "what did *Claude*
figure out about this task?" and "what is the *whole project* state across every
tool?" Per-tool global KBs answer the first; the per-project KB answers the
second. Both are filled by the same watcher — destinations, not sources.

### 4.2 Knowledge Model

Every captured session produces **two artifacts** in its tool's KB:

#### 4.2.1 Structured task-summary file (the primary ~70% artifact)

`wiki/sessions/<timestamp>-<slug>.md`, with these fixed sections:

```markdown
# 2026-07-09 14:23 — auth refactor  (source: claude, cwd: ~/proj, git: a1b2c3d)

## Task / Goal
The end goal of this session, in one or two sentences. The *intention*.

## Files Traversed
For each file the tool touched (read or wrote), with the chain of reasoning:
- src/auth/login.ts — entry point; needed to find the POST /login handler
  - `loginHandler()` — validated credentials, called `issueToken()`; checked
    because the task symptom was a misdirect after login
  - `issueToken()` — minted a JWT but never set the refresh cookie; this was
    the actual bug location
- src/auth/refresh.ts — followed from issueToken() to confirm refresh flow
  - `refreshToken()` — confirmed it expects a cookie that was never written
Reasoning narrative: why this traversal path, not another.

## Changes Made
Each edit, grounded to file:symbol, with reason + (optional) git block:
- src/auth/login.ts:`issueToken()` — set `refreshToken` httpOnly cookie before
  responding. Reason: refresh endpoint could never read it otherwise.
  - diff: +6 -2  (commit a1b2c3d)
- src/auth/refresh.ts — no change needed, confirmed correct

## Final Result
Did the task finish? What is the observable end state? e.g. "Login now sets
both access + refresh tokens; manual test passes; 2 tests added."

## Open Threads
What the next session should pick up:
- Add integration test covering refresh-with-cookie
- Rate-limit the refresh endpoint (unrelated, noticed mid-trace)
```

This is the heart of Central Memory: a *grounded logical* summary, not a chat
dump. Every claim cites a `file:symbol`; traversal explains *why*, changes
explain *why toward the goal*, and the result states *where the task stands*.

#### 4.2.2 Rolling topic-merge files (the light ~30% layer)

The session also feeds two long-lived, reconciliation-style files so durable
facts accumulate across many sessions instead of being trapped in one:

- `wiki/decisions-log.md` — append-only entries like
  `## 2026-07-09 — use httpOnly cookie for refresh token` with rationale; new
  entries that contradict old ones are flagged (current merger behavior, kept).
- `wiki/file-changes.md` — append-only change log with `file:symbol`, commit,
  one-line reason. This is the project's "what changed and why" history.

These are intentionally thin: most of the value lives in the per-task session
file (§4.2.1). The merge files exist so that a quick `kb inject` without a
specific task still surfaces durable state.

#### 4.2.3 Per-task roll-up (built across sessions + tools)

`wiki/tasks/<slug>.md` aggregates *every* session — from any tool — that worked
on the same task, in chronological order, ending with the latest open threads.
This is what `kb inject --task <slug>` returns. It is the resume document.

### 4.3 System Components

```
┌──────────────────────────────────────────────────────────────────┐
│                         kb CLI (no REPL)                          │
│                                                                   │
│  kb start          kb stop          kb status                     │
│  kb capture <--from NAME>           kb inject <--tool/--task>      │
│  kb recall "..."   kb log "..."     kb review     kb export        │
└──────────────────────────────┬───────────────────────────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        ▼                                              ▼
┌────────────────────┐                       ┌──────────────────────┐
│  watcher (bg)       │                       │  extractor pipeline   │
│  chokidar on every  │──session file──────▶ │  parse → chunk →       │
│  detected tool dir  │   change              │  LLM understand →     │
└────────────────────┘                       │  structure (§4.2) →    │
        ▲                                    │  embed → write KB     │
        │ auto-detects all tools             └──────────┬───────────┘
        │                                                ▼
        │                                       ┌─────────────────┐
        │                                       │  per-tool KBs    │
        └────────────────────────────────────── │  + ./kb/ project │
                                                └─────────────────┘
```

- **Watcher**: background daemon; auto-detects every installed tool and watches
  its session directory. No manual `--tools` flag needed by default.
- **Extractor**: the only place an LLM is called. Uses whatever provider key the
  user has (Groq / Gemini / OpenAI-compatible / Anthropic / NVIDIA / Cloudflare).
  Produces structured Markdown per §4.2.
- **Wiki engine**: writes session files, appends to merge files, maintains
  `index.md`, links task roll-ups, and feeds LanceDB for semantic search.
- **Inject / recall**: read-only. Render a primer from the KB; never call an LLM
  (so there are no extra token costs to *restore* memory).

### 4.4 Session File Locations (watched dirs)

The watcher auto-discovers any present tool by probing for these directories:

| Tool | Discovery path (probed, not required) | Format |
|------|--------------------------------------|--------|
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/*.jsonl` | JSONL |
| **Kimchi** | `<cwd>/.kimchi/sessions/*.jsonl` | JSONL |
| **OpenCode** | `~/.local/share/opencode/sessions/*.jsonl` *(TBD — confirm on first install)* | JSONL |
| **Codex** | `~/.codex/sessions/*.jsonl` *(TBD — confirm)* | JSONL |
| **Cline** | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<id>/api_conversation_history.json` | JSON |

`kb start` probes each path and silently skips tools that aren't installed.
`kb start --tools claude,kimi` narrows the set if a user insists. Paths for
OpenCode and Codex are open questions (§9) — the watcher is plugin-shaped so
adding a locator is a one-file change.

---

## 5. CLI Commands

The interactive `kb agent` command is **removed**. The command surface is now
small and oriented around the Central-Memory lifecycle.

### 5.1 `kb start` / `kb stop` / `kb status` — the background watcher

```bash
kb start                       # auto-detect every installed tool and watch all
kb start --tools claude,kimi   # restrict to a subset
kb stop                        # stop the daemon
kb status                      # is it running? which tools? last capture?
```

This replaces the old `kb capture --watch / --stop / --status` cluster. The
watcher is the *default* way to use `kb` — most users will run `kb start` once
and never type another command until they want to restore memory.

### 5.2 `kb capture` — manual / one-shot capture

```bash
kb capture                                   # read a transcript from stdin
kb capture --from claude                      # capture the latest Claude session now
kb capture --from kimi --task refactor-auth   # tag the capture with a task slug
kb capture --file session.txt
kb capture --global                           # write only to the tool's global KB (skip ./kb/)
```

`--from <tool>` replaces the old `--last-claude / --last-cline / --last-kimchi`
family. `--task <slug>` tags the session so it joins the right task roll-up
(§4.2.3). If `--task` is omitted the extractor infers a slug from the goal.

### 5.3 `kb inject` — restore memory into a new session

```bash
kb inject                       # project KB primer: latest work across all tools
kb inject --tool claude         # only Claude's memory for this project
kb inject --task refactor-auth  # the full cross-tool roll-up for one task
kb inject --last                # only the most recent session file (any tool)
kb inject --tool kimi --last    # most recent Kimchi session
kb inject --copy                # copy to clipboard
```

Output is plain text the user pastes into any new session — works with every
tool, provider, and model, because inject calls no LLM. `--task` is the primary
resume path (§4.2.3); `--last` is the quick "where did I leave off" path.

### 5.4 `kb recall` — semantic search (renamed from `search`)

```bash
kb recall "auth middleware"           # across project + all tool KBs
kb recall --tool claude "decisions"   # only Claude's KB
kb recall --project "error handling"  # only ./kb/, all tools
kb recall --max 10 "race condition"
```

Renames avoid confusing "search the codebase" (the deleted agent's `code_search`
tool did that) with "search the memory." `recall` only searches KBs.

### 5.5 `kb log` — manual fact

```bash
kb log "Decided to use Redis for session caching"
kb log --category decision "Switched from Jest to Vitest"
kb log --tool claude --task refactor-auth "spotted race in refreshToken"
```

Writes a single durable entry into the relevant KB without needing a full
session capture. `--tool` defaults to an `unattributed` bucket.

### 5.6 `kb status` / `kb review` / `kb export`

```bash
kb status                # per-tool + per-project breakdown: files, facts, last capture, watcher state
kb review --since 3d     # recent KB changes + flagged contradictions
kb export                # tar.gz snapshot (add --global to export ~/.kb)
```

### 5.7 Removed commands

| Removed | Reason |
|---------|--------|
| `kb agent` | Claude-Code-like REPL — out of scope (§2.2). Whole `src/agent/` deleted. |
| `kb map`, `kb distill`, `kb inject --feature/--snippets/--verify` | Comprehension-trace subsystem that strong-model-traced live code. Central Memory derives from *past sessions*, not live code, so this is replaced by the session-summary extractor (§4.2). The `src/comprehension/` module is removed. |

---

## 6. Source Code Structure (target)

```
kb-cli/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                  ← CLI entry (commander); no agent command
│   ├── commands/
│   │   ├── start.ts              ← kb start (watcher control, replaces --watch flags)
│   │   ├── capture.ts            ← kb capture ← stdin / --from / --file
│   │   ├── capture-runner.ts     ← shared pipeline runner
│   │   ├── inject.ts             ← kb inject
│   │   ├── recall.ts             ← kb recall  (was search.ts)
│   │   ├── log.ts                ← kb log
│   │   ├── status.ts             ← kb status
│   │   ├── review.ts             ← kb review
│   │   ├── export.ts             ← kb export
│   │   └── init.ts               ← kb init
│   ├── extractor/
│   │   ├── pipeline.ts           ← orchestrates: parse → understand → write KB
│   │   ├── session-parser.ts     ← NEW: tool-specific transcript → normalized turns
│   │   ├── understand.ts         ← NEW: the §4.2.1 structured-summary LLM call
│   │   ├── prompts.ts            ← rewritten: structured summary + traversal prompts
│   │   ├── task-rollup.ts        ← NEW: merge sessions into wiki/tasks/<slug>.md
│   │   └── chunker.ts
│   ├── wiki/
│   │   ├── engine.ts             ← read/write structured session + merge files
│   │   ├── indexer.ts            ← maintain per-tool + project index.md
│   │   └── merger.ts             ← decisions-log / file-changes appends + contradiction flag
│   ├── vectors/
│   │   ├── store.ts             ← LanceDB per-tool tables
│   │   ├── embed.ts
│   │   └── search.ts
│   ├── watcher/
│   │   ├── daemon.ts            ← kb start worker; auto-detect tools
│   │   └── providers.ts        ← per-tool session locators (Claude/Kimi/OpenCode/Codex/Cline)
│   ├── providers/              ← LLM providers (unchanged) used only by extractor
│   ├── config.ts
│   ├── storage.ts              ← extended: per-tool KB roots under ~/.kb/<tool>/
│   ├── types.ts
│   └── git.ts
└── test/
    ├── extractor.test.ts
    ├── wiki.test.ts
    └── integration.test.ts
```

**Deleted from current code:**

- `src/commands/agent.ts` and the whole `src/agent/` directory (loop, prompts,
  session, tools, types) — the REPL. ~512 lines.
- `src/commands/map.ts`, `src/commands/distill.ts` and the whole
  `src/comprehension/` directory (distill, ground, map, prompts, render,
  snippets, store) — the live-code tracing subsystem that Central Memory does
  not need. ~1,184 lines.
- `kb inject` options `--feature`, `--snippets`, `--verify` and the README
  sections that document them.
- The bash/zsh completion entries for `agent`, `map`, `distill`.

**Added / rewritten:**

- `extractor/session-parser.ts` — tool-aware transcript parser (one normalizer
  per tool, reusing the existing reader logic in `watcher/providers.ts`).
- `extractor/understand.ts` + rewrite of `extractor/prompts.ts` — the
  structured-summary extraction (§4.2.1).
- `extractor/task-rollup.ts` — builds/updates `wiki/tasks/<slug>.md`.
- `storage.ts` gains `toolRoot(tool)` → `~/.kb/<tool>/`, plus a `source:` tag
  on every project-KB session file.
- `watcher/daemon.ts` gains auto-detection (probe each tool's dir; skip the
  absent ones) and is exposed via `kb start` instead of `kb capture --watch`.

---

## 7. The Structured-Summary Extraction (the heart of Central Memory)

The extraction prompt is rewritten to produce understanding, not a fact list.

### 7.1 System prompt (extractor/understand.ts)

> You are the comprehension layer of a Central Memory for AI coding tools.
> You are given a transcript of one session produced by `<tool>` in the codebase
> at `<cwd>` at git ref `<ref>`. Derive a **logical understanding** of the
> session, not a literal summary of messages.
>
> Produce Markdown with exactly these sections, in this order:
>
> 1. **Task / Goal** — the end intention of the session (1–2 sentences).
> 2. **Files Traversed** — every file/symbol the tool read or reasoned about,
>    grouped by the *chain of reasoning* that led there. For each, name the
>    `file:symbol` and one sentence on *why* it was checked and *what it does*.
>    Prefer a short narrative over a flat list.
> 3. **Changes Made** — every file edit, as `file:symbol` + reason + optional
>    diffstat/commit. The reason must explain how the edit advanced the goal.
>    State "no change" explicitly if a file was only read.
> 4. **Final Result** — observable end state, whether the goal was reached, and
>    any verification that confirmed it.
> 5. **Open Threads** — concrete next steps the next session should pick up.
>
> Every claim about code must cite a `file:symbol` that exists in the transcript.
> If a symbol is inferred but not literally present, mark it `(inferred)`. Do
> not invent files. Return Markdown only.

### 7.2 Why this beats a fact list

A weak model receiving the §4.2.1 file can *think* its way through the task
without re-reading the codebase: it sees the traversal rationale (so it knows
which symbols matter and why), the change rationale (so it knows what's already
solved and why), and the open threads (so it knows where to start). That is the
"full logical reason" the user asked for.

### 7.3 Chunking

Keep the existing chunker but lower the ceiling so cheap extraction models can
hold a whole task in one call where possible (`chunkSize` default 12000 chars;
prompt asks the model to focus on the final state and reference earlier chunks).
For very long sessions, the extractor is called per chunk and then a final
*reconcile* pass merges per-chunk drafts into one session file — this is what
`task-rollup.ts` partially reuses.

### 7.4 Provider usage

Unchanged from current: the extractor uses whatever key is available, preferring
cheap/fast providers (Groq → Gemini → OpenAI → OpenAI-compat → Anthropic →
Cloudflare → NVIDIA) via `resolveProvider`. **No provider is used for `inject`,
`recall`, `status`, `review`, or `log`** — those are pure file reads. Token cost
is paid only once, at capture time.

---

## 8. Configuration

### 8.1 `~/.kb/config.json`

```json
{
  "extractor": {
    "provider": "auto",
    "model": "llama-3.3-70b-versatile",
    "chunkSize": 12000,
    "reasoningEffort": "high"
  },
  "watch": {
    "tools": "auto",
    "pollIntervalMs": 5000
  },
  "embedding": { "mode": "hash", "dimensions": 256 },
  "autoCommit": true,
  "destinations": { "project": true, "global": true }
}
```

- `watch.tools: "auto"` → watcher auto-detects every installed tool.
- `destinations` controls whether a capture writes to the per-tool global KB,
  the project KB (`./kb/`), or both (default both).
- The old `agent` config block is removed.

### 8.2 `./kb/.kbconfig.json` (per-project overrides)

Same shape, merged on top. Lets a repo pin a stronger extractor model or disable
global writing for sensitive projects.

---

## 9. Open Questions

1. **OpenCode / Codex session paths** — confirm where these tools store session
   files. The watcher is plugin-shaped, so adding a locator later is cheap, but
   we want at least Claude, Kimchi, Cline working on day one.
2. **Task slug inference** — when `--task` is omitted, how aggressively should
   the extractor assign a session to an existing task roll-up vs. start a new
   one? Plan: extract a one-line "task name" and fuzzy-match against existing
   `wiki/tasks/*.md` titles; create a new task if similarity < threshold.
3. **Per-tool vs. cross-tool task roll-ups** — should `wiki/tasks/<slug>.md` in
   a tool KB roll up that tool's sessions only, or should the *project* KB be the
   single place where all tools' sessions for a task merge? Current design: the
   project KB (`./kb/wiki/tasks/`) is authoritative for cross-tool roll-ups;
   per-tool KBs keep tool-only roll-ups for "what did *this* tool do on this task".
4. **Stale-state detection** — if a captured session cited symbols that were
   later renamed/deleted, should `kb review` flag the session as stale? Likely
   yes, but the verification mechanism (re-open files? trust git?) is open.
5. **Embedding mode** — keep the current `"hash"` (no API cost) default, or is
   `"api"` (provider embeddings) worth the cost for better `recall` ranking?
6. **Watch vs. poll** — chokidar watches dirs directly; for tools that write
   many small session files (Codex?), polling the newest file may be more robust.

---

## 10. Implementation Order (refactor → MVP v2)

1. **Delete out-of-scope code** — `src/agent/`, `src/comprehension/`,
   `commands/agent.ts`, `commands/map.ts`, `commands/distill.ts`; strip their
   flags and help/completion lines from `src/index.ts` and README. Verify
   `npm run typecheck` + `npm test` still pass.
2. **Per-tool storage** — extend `storage.ts` with `toolRoot(tool)`,
   `toolRoot`-aware `wikiDir / vectorsDir / sessionsDir / tasksDir`; update
   `init.ts` to create the per-tool tree under `~/.kb/`.
3. **Rewrite extraction** — `extractor/understand.ts` + new `prompts.ts`
   producing §4.2.1; add `session-parser.ts` (tool-aware); keep `decisions-log`
   / `file-changes` as the light §4.2.2 layer.
4. **Task roll-ups** — `extractor/task-rollup.ts`; `inject --task` reads them.
5. **Watcher as default** — `kb start/stop/status`; auto-detect tools in
   `daemon.ts`; route each captured session to the correct per-tool KB + the
   project KB with a `source:` tag.
6. **Rename + clean CLI** — `search` → `recall`; remove `--feature/--snippets/
   --verify`; replace `--last-claude…` with `--from <tool>`.
7. **Update README + design doc sign-off.**

---

## Appendix A: Migration map (old flag → new)

| Old | New | Notes |
|-----|-----|-------|
| `kb capture --watch` | `kb start` | Watcher is its own command; auto-detects tools |
| `kb capture --stop` | `kb stop` | |
| `kb capture --status` | `kb status` | (was on `kb status`) |
| `--last-claude / --last-cline / --last-kimchi / --last` | `--from <tool>` / `--from auto` | One flag, any tool |
| `kb agent` | *(removed)* | Use a real coding tool; `kb` only stores memory |
| `kb map`, `kb distill`, `kb inject --feature…` | `kb inject --task <slug>` | Memory derived from past sessions, not live tracing |

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Central Memory** | `kb`'s role: a passive, per-tool, queryable memory of every AI coding session |
| **Task-summary file** | `wiki/sessions/<ts>-<slug>.md` — the per-session structured understanding (§4.2.1) |
| **Task roll-up** | `wiki/tasks/<slug>.md` — chronological merge of every session (any tool) for one task |
| **Traversal rationale** | Why each file/symbol was reached, not just that it was read |
| **Per-tool KB** | `~/.kb/<tool>/` — that tool's complete session history across all projects |
| **Project KB** | `./kb/` — every tool's work on one codebase, sessions tagged `source:` |
| **Grounded** | Every code claim cites a `file:symbol` present in the transcript |
