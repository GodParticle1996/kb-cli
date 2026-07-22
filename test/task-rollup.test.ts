import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTaskRollup } from "../src/extractor/task-rollup.js";
import { ensureWikiStructure } from "../src/wiki/engine.js";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "kb-rollup-"));
}

const SUMMARY = [
  "## Task / Goal",
  "",
  "Refactor the auth module.",
  "",
  "## Files Traversed",
  "",
  "- src/auth/login.ts:issueToken",
  "- src/auth/refresh.ts:refreshToken",
  "",
  "## Changes Made",
  "",
  "- src/auth/login.ts:issueToken — set cookie",
  "",
  "## Final Result",
  "",
  "Login sets both tokens.",
  "",
  "## Open Threads",
  "",
  "- Add integration test covering refresh-with-cookie.",
  "- Rate-limit the refresh endpoint.",
].join("\n");

describe("appendTaskRollup", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
    ensureWikiStructure("project", cwd);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("creates a titled roll-up with chronological + open-threads sections", () => {
    const rel = appendTaskRollup(
      "project",
      "refactor-auth",
      {
        label: "2026-07-09T12-00",
        tool: "claude",
        timestamp: "2026-07-09T12:00:00.000Z",
        sessionRel: "sessions/2026-07-09T12-00.claude.md",
        sessionMarkdown: SUMMARY,
      },
      cwd,
    );
    expect(rel).toBe("tasks/refactor-auth.md");
    const body = readFileSync(join(cwd, "kb", "wiki", "tasks", "refactor-auth.md"), "utf8");
    expect(body).toContain("# Task: refactor-auth");
    expect(body).toContain("## Sessions (chronological)");
    expect(body).toContain("### 2026-07-09T12-00 — claude, 2026-07-09");
    expect(body).toContain("**goal:** Refactor the auth module.");
    expect(body).toContain("files: 2 traversed · changes: 1 made · open threads: 2");
    expect(body).toContain("## Current open threads (from 2026-07-09T12-00, claude)");
    expect(body).toContain("- Add integration test covering refresh-with-cookie.");
  });

  it("appends a second session and re-emits the LATEST open threads", () => {
    appendTaskRollup(
      "project",
      "refactor-auth",
      {
        label: "s1",
        tool: "claude",
        timestamp: "2026-07-09T12:00:00.000Z",
        sessionRel: "sessions/s1.claude.md",
        sessionMarkdown: SUMMARY,
      },
      cwd,
    );

    const laterSummary = SUMMARY.replace(
      "- Add integration test covering refresh-with-cookie.\n- Rate-limit the refresh endpoint.",
      "- Integration tests added.\n- Need to wire rate-limiting config.",
    );
    appendTaskRollup(
      "project",
      "refactor-auth",
      {
        label: "s2",
        tool: "codex",
        timestamp: "2026-07-10T09:00:00.000Z",
        sessionRel: "sessions/s2.codex.md",
        sessionMarkdown: laterSummary,
      },
      cwd,
    );

    const body = readFileSync(join(cwd, "kb", "wiki", "tasks", "refactor-auth.md"), "utf8");
    // Both sessions present, chronological.
    expect(body).toContain("### s1 — claude");
    expect(body).toContain("### s2 — codex");
    expect(body.indexOf("### s1")).toBeLessThan(body.indexOf("### s2"));
    // Latest open threads replace the previous ones.
    expect(body).toContain("Need to wire rate-limiting config.");
    expect(body).not.toContain("Rate-limit the refresh endpoint.");
    // Latest-threads header names the most recent session.
    expect(body).toContain("## Current open threads (from s2, codex)");
  });
});
