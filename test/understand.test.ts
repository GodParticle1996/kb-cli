import { describe, expect, it } from "vitest";
import { normalizeSummary, hasRealContent, reconcileSummaries, extractSection, heuristicSummary } from "../src/extractor/understand.js";

describe("normalizeSummary", () => {
  it("returns the five canonical sections in order with _None._ for blanks", () => {
    const raw = [
      "## Task / Goal",
      "",
      "Refactor the login handler.",
      "",
      "## Open Threads",
      "",
      "- add refresh-token tests",
      "",
    ].join("\n");
    const md = normalizeSummary(raw);
    expect(md).toContain("## Task / Goal");
    expect(md).toContain("## Files Traversed");
    expect(md).toContain("## Changes Made");
    expect(md).toContain("## Final Result");
    expect(md).toContain("## Open Threads");
    // Sections are in canonical order.
    expect(md.indexOf("## Task / Goal")).toBeLessThan(md.indexOf("## Files Traversed"));
    expect(md.indexOf("## Files Traversed")).toBeLessThan(md.indexOf("## Changes Made"));
    expect(md.indexOf("## Changes Made")).toBeLessThan(md.indexOf("## Final Result"));
    expect(md.indexOf("## Final Result")).toBeLessThan(md.indexOf("## Open Threads"));
    // Blank section body fills with _None._.
    expect(extractSection(md, "Files Traversed")).toBe("_None._");
    expect(md).toContain("## Files Traversed\n\n_None._");
  });

  it("strips markdown fences and preamble", () => {
    const raw = "Here:\n```markdown\n## Task / Goal\nGoal: ship it.\n```\ndone.";
    const md = normalizeSummary(raw);
    expect(extractSection(md, "Task / Goal")).toContain("ship it");
  });

  it("preserves unknown LLM prose under Task/Goal when no headings detected", () => {
    const md = normalizeSummary("just some prose about the session");
    expect(extractSection(md, "Task / Goal")).toContain("just some prose");
  });
});

describe("hasRealContent", () => {
  it("true when any non-Open-Threads section has content", () => {
    const md = "## Task / Goal\n\nGoal.\n\n## Files Traversed\n\n## Changes Made\n\n## Final Result\n\n## Open Threads\n\n- next";
    expect(hasRealContent(md)).toBe(true);
  });
  it("false when every non-Open-Threads section is _None._", () => {
    const md = "## Task / Goal\n\n_None._\n\n## Files Traversed\n\n_None._\n\n## Changes Made\n\n_None._\n\n## Final Result\n\n_None._\n\n## Open Threads\n\n- a";
    expect(hasRealContent(md)).toBe(false);
  });
});

describe("reconcileSummaries", () => {
  it("keeps the first non-empty Task/Goal and concatenates other sections", () => {
    const a = "## Task / Goal\n\nBuild auth.\n\n## Files Traversed\n\n- a.ts:foo\n\n## Changes Made\n\n## Final Result\n\n## Open Threads\n\n- tests";
    const b = "## Task / Goal\n\nAlso wire refresh.\n\n## Files Traversed\n\n- b.ts:bar\n\n## Changes Made\n\n- b.ts:bar — adds cookie\n\n## Final Result\n\n- works\n\n## Open Threads\n\n- rate limit";
    const merged = reconcileSummaries([a, b]);
    expect(extractSection(merged, "Task / Goal")).toContain("Build auth.");
    expect(extractSection(merged, "Task / Goal")).toContain("Also wire refresh.");
    expect(extractSection(merged, "Files Traversed")).toContain("a.ts:foo");
    expect(extractSection(merged, "Files Traversed")).toContain("b.ts:bar");
    expect(extractSection(merged, "Changes Made")).toContain("adds cookie");
    expect(extractSection(merged, "Final Result")).toContain("works");
    expect(extractSection(merged, "Open Threads")).toContain("rate limit");
  });
});

describe("heuristicSummary", () => {
  it("emits all five sections for a sparse transcript", () => {
    const md = heuristicSummary("Decided to use Postgres. TODO: write tests", "claude");
    expect(md).toContain("## Task / Goal");
    expect(md).toContain("## Open Threads");
    expect(extractSection(md, "Open Threads")).toContain("write tests");
    // Changes Made is empty-fill ("_None._") in the heuristic skeleton.
    expect(extractSection(md, "Changes Made")).toBe("_None._");
  });
});
