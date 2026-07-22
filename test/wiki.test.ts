import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedFact } from "../src/types.js";
import { mergeFacts } from "../src/wiki/merger.js";
import { regenerateIndex, buildIndex } from "../src/wiki/indexer.js";
import { countFacts, listWikiFiles, readWikiFile } from "../src/wiki/engine.js";
import { ensureWikiStructure } from "../src/wiki/engine.js";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "kb-test-"));
}

function makeFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    id: `f-${Math.random().toString(36).slice(2)}`,
    content: "Use Redis for session caching",
    category: "decision",
    source: "test-session",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("wiki merger", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
    ensureWikiStructure("project", cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appends a decision to decisions-log.md", () => {
    const fact = makeFact({ content: "Use Postgres for the main DB" });
    const result = mergeFacts("project", [fact], cwd);
    expect(result.appended).toBe(1);
    expect(result.filesWritten).toContain("decisions-log.md");
    const body = readWikiFile("project", "decisions-log.md", cwd);
    expect(body).toContain("Use Postgres for the main DB");
  });

  it("deduplicates near-identical facts", () => {
    const fact = makeFact({ content: "Use Postgres for the main DB" });
    mergeFacts("project", [fact], cwd);
    const result2 = mergeFacts("project", [fact], cwd);
    expect(result2.appended).toBe(0);
    expect(result2.skippedDuplicates).toBe(1);
  });

  it("flags contradictions with the warning marker", () => {
    mergeFacts("project", [makeFact({ content: "Use Postgres for the main DB" })], cwd);
    const result = mergeFacts(
      "project",
      [makeFact({ content: "Switched from Postgres to SQLite for the main DB" })],
      cwd,
    );
    expect(result.contradictions.length).toBeGreaterThan(0);
    const body = readWikiFile("project", "decisions-log.md", cwd);
    expect(body).toContain("⚠️");
  });
});

describe("wiki indexer", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
    ensureWikiStructure("project", cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("regenerates index.md listing wiki files", () => {
    mergeFacts("project", [makeFact({ content: "Decided on a layered architecture" })], cwd);
    regenerateIndex("project", cwd);
    const index = readWikiFile("project", "index.md", cwd);
    expect(index).toContain("Knowledge Base Index");
    expect(index).toContain("decisions-log.md");
  });

  it("countFacts counts list items and subsections", () => {
    mergeFacts("project", [makeFact({ content: "Use Vitest" }), makeFact({ content: "Use ESLint" })], cwd);
    const n = countFacts("project", cwd);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("listWikiFiles returns md files", () => {
    mergeFacts("project", [makeFact()], cwd);
    const files = listWikiFiles("project", cwd);
    expect(files.some((f) => f.relPath === "decisions-log.md")).toBe(true);
  });

  it("buildIndex handles empty wiki", () => {
    const index = buildIndex("project", cwd);
    expect(index).toContain("No wiki entries yet");
  });
});
