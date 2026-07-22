import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { KbConfig } from "../src/types.js";
import { runInit } from "../src/commands/init.js";
import { runCapture } from "../src/commands/capture-runner.js";
import { runInject } from "../src/commands/inject.js";
import { runLog } from "../src/commands/log.js";
import { isKbInitialized } from "../src/storage.js";
import { readWikiFile } from "../src/wiki/engine.js";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "kb-int-"));
}

const NO_LLM_CONFIG: KbConfig = {
  ...DEFAULT_CONFIG,
  autoCommit: false, // avoid git in tests
  embedding: { ...DEFAULT_CONFIG.embedding, mode: "hash" },
};

describe("kb integration: init -> capture -> inject -> log", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("initializes a project KB with index.md and content files", () => {
    const result = runInit({ cwd });
    expect(result.created).toBe(true);
    expect(isKbInitialized("project", cwd)).toBe(true);
    expect(existsSync(join(cwd, "kb", "wiki", "index.md"))).toBe(true);
    expect(existsSync(join(cwd, "kb", "wiki", "decisions-log.md"))).toBe(true);
  });

  it("captures a session via the heuristic fallback and injects it", async () => {
    runInit({ cwd });
    const session = `We decided to use Postgres for the main database.
Let's use a layered architecture with a service layer.
TODO: write integration tests
We fixed a bug where the login endpoint returned 500 by adding null checks.`;

    const result = await runCapture({
      raw: session,
      label: "integration-test-session",
      tool: "claude",
      config: NO_LLM_CONFIG,
      cwd,
    });

    expect(result.factsExtracted).toBeGreaterThan(0);
    // Session summary file should exist (tagged `.claude.md`).
    expect(existsSync(join(cwd, "kb", "wiki", "sessions", "integration-test-session.claude.md"))).toBe(
      true,
    );

    // inject should produce context referencing captured content.
    const { text } = runInject({ cwd });
    expect(text).toContain("Previous Session Context");
  });

  it("logs a manual fact and makes it appear in inject output", async () => {
    runInit({ cwd });
    const out = await runLog({
      message: "Decided to use LanceDB for the vector store",
      category: "decision",
      config: NO_LLM_CONFIG,
      cwd,
    });
    expect(out).toContain("project KB");
    const body = readWikiFile("project", "decisions-log.md", cwd);
    expect(body).toContain("LanceDB");

    const { text } = runInject({ topic: "LanceDB", cwd });
    expect(text).toContain("LanceDB");
  });

  it("inject reports no context when KB is empty/uninitialized", () => {
    // Don't init — inject should gracefully report nothing captured.
    const { text } = runInject({ cwd });
    expect(text).toContain("No captured context found");
  });
});

// ---------------------------------------------------------------------------
// Structured summary + task roll-up, exercised with a fake LLM provider.
// ---------------------------------------------------------------------------

import type { ChatRequest, ChatResponse, LlmProvider, ProviderName } from "../src/types.js";

function fakeProvider(understandMd: string, facts: { content: string; category: string }[]): LlmProvider {
  return {
    name: "groq" as ProviderName,
    label: "fake",
    available: true,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      // Distinguish the two prompts by a marker in the system prompt.
      if (req.system.includes("comprehension layer")) {
        return { text: understandMd, provider: "groq" as ProviderName, model: "fake" };
      }
      // Fact-extraction prompt — return JSON.
      return {
        text: JSON.stringify(facts),
        provider: "groq" as ProviderName,
        model: "fake",
      };
    },
  };
}

const SUMMARY_MD = [
  "## Task / Goal",
  "",
  "Refactor the auth module to fix the missing refresh-token cookie.",
  "",
  "## Files Traversed",
  "",
  "- src/auth/login.ts:loginHandler — entry; handles POST /login, calls issueToken.",
  "- src/auth/login.ts:issueToken — found the bug here; it never set the refresh cookie.",
  "- src/auth/refresh.ts:refreshToken — followed from issueToken to confirm the cookie is expected.",
  "",
  "## Changes Made",
  "",
  "- src/auth/login.ts:issueToken — set the httpOnly refresh cookie before responding (+6 -2).",
  "- src/auth/refresh.ts — no change; confirmed correct.",
  "",
  "## Final Result",
  "",
  "Login now sets both access + refresh tokens; manual test passes; 2 tests added.",
  "",
  "## Open Threads",
  "",
  "- Add integration test covering refresh-with-cookie.",
  "- Rate-limit the refresh endpoint (noticed mid-trace).",
].join("\n");

describe("kb structured capture + task rollup (fake provider)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes a five-section session file and a task roll-up with open threads", async () => {
    runInit({ cwd });
    const config: KbConfig = {
      ...DEFAULT_CONFIG,
      autoCommit: false,
      embedding: { ...DEFAULT_CONFIG.embedding, mode: "hash" },
      // Project-only for this test (skip per-tool global fan-out).
      destinations: { project: true, global: false },
    };
    // Patch capture-runner to use our fake provider by calling runPipeline directly.
    const { runPipeline } = await import("../src/extractor/pipeline.js");
    const provider = fakeProvider(SUMMARY_MD, [
      { content: "Use Postgres for the auth DB", category: "decision" },
      { content: "httpOnly cookie set for refresh token", category: "file-change" },
    ]);

    const result = await runPipeline({
      raw: "We decided to use Postgres for the auth database. Refactored login to set the httpOnly refresh cookie before responding. TODO: refresh cookies refresh endpoint rate limit.",
      sessionLabel: "2026-07-09-auth-refactor",
      tool: "claude",
      task: "refactor-auth",
      provider,
      config,
      cwd,
    });

    expect(result.factsExtracted).toBe(2);
    const session = readFileSync(
      join(cwd, "kb", "wiki", "sessions", "2026-07-09-auth-refactor.claude.md"),
      "utf8",
    );
    expect(session).toContain("## Task / Goal");
    expect(session).toContain("## Files Traversed");
    expect(session).toContain("## Changes Made");
    expect(session).toContain("## Final Result");
    expect(session).toContain("## Open Threads");
    expect(session).toContain("src/auth/login.ts:issueToken");

    // Task roll-up file should exist with the resume-doc shape.
    expect(existsSync(join(cwd, "kb", "wiki", "tasks", "refactor-auth.md"))).toBe(true);
    const rollup = readFileSync(join(cwd, "kb", "wiki", "tasks", "refactor-auth.md"), "utf8");
    expect(rollup).toContain("# Task: refactor-auth");
    expect(rollup).toContain("## Sessions (chronological)");
    expect(rollup).toContain("### 2026-07-09-auth-refactor — claude");
    expect(rollup).toContain("## Current open threads");
    expect(rollup).toContain("Rate-limit the refresh endpoint");

    // inject --task returns the roll-up.
    const { text } = runInject({ task: "refactor-auth", cwd });
    expect(text.toLowerCase()).toContain("task roll-up");
    expect(text.toLowerCase()).toContain("add integration test covering refresh-with-cookie");
  });
});
