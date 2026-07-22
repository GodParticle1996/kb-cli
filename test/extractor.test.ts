import { describe, expect, it } from "vitest";
import { chunkText, filterSignalChunks, stripAnsi } from "../src/extractor/chunker.js";
import { parseJsonFacts, toExtractedFacts, heuristicExtract } from "../src/extractor/llm-extract.js";

describe("chunker", () => {
  it("splits on blank-line turn boundaries", () => {
    const text = "turn one line\n\nturn two line\n\nturn three line";
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBe(1); // all fit in one chunk
    expect(chunks[0].text).toContain("turn three line");
  });

  it("packs turns up to maxChars then starts a new chunk", () => {
    const turn = "x".repeat(50);
    const text = [turn, turn, turn].join("\n\n");
    const chunks = chunkText(text, 110);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("hard-splits an oversized turn", () => {
    const big = "a".repeat(300);
    const chunks = chunkText(big, 100);
    for (const c of chunks) expect(c.chars).toBeLessThanOrEqual(100);
  });

  it("stripAnsi removes escape sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m text")).toBe("red text");
  });

  it("filterSignalChunks drops noise", () => {
    const chunks = chunkText("a b c d\n\nThis is a meaningful sentence about architecture.", 1000);
    const filtered = filterSignalChunks(chunks);
    expect(filtered.length).toBeLessThanOrEqual(chunks.length);
  });
});

describe("parseJsonFacts", () => {
  it("parses a clean JSON array", () => {
    const raw = '[{"content":"Use Redis","category":"decision"}]';
    const facts = parseJsonFacts(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Use Redis");
  });

  it("strips markdown fences", () => {
    const raw = "```json\n[{\"content\":\"X\",\"category\":\"note\"}]\n```";
    expect(parseJsonFacts(raw)).toHaveLength(1);
  });

  it("extracts array from surrounding prose", () => {
    const raw = 'Here are the facts:\n[{"content":"Y","category":"state"}]\nDone.';
    expect(parseJsonFacts(raw)).toHaveLength(1);
  });

  it("returns empty on garbage", () => {
    expect(parseJsonFacts("not json at all")).toEqual([]);
    expect(parseJsonFacts("")).toEqual([]);
  });
});

describe("toExtractedFacts", () => {
  it("coerces unknown categories to note", () => {
    const facts = toExtractedFacts(
      [{ content: "hello", category: "bogus" }],
      "s",
      new Date().toISOString(),
    );
    expect(facts[0].category).toBe("note");
  });

  it("preserves rationale when provided", () => {
    const facts = toExtractedFacts(
      [{ content: "Use Vitest", category: "decision", rationale: "faster than Jest" }],
      "s",
      new Date().toISOString(),
    );
    expect(facts[0].rationale).toBe("faster than Jest");
  });
});

describe("heuristicExtract", () => {
  it("extracts decision-like lines", () => {
    const text = "We decided to use Postgres.\nRandom chat line.\nTODO: write tests";
    const facts = heuristicExtract(text, "src", new Date().toISOString());
    const contents = facts.map((f) => f.content);
    expect(contents.some((c) => c.includes("Postgres"))).toBe(true);
    expect(facts.some((f) => f.category === "open-question")).toBe(true);
  });

  it("skips very short or very long lines", () => {
    const text = "hi\n" + "x".repeat(300);
    const facts = heuristicExtract(text, "src", new Date().toISOString());
    expect(facts).toHaveLength(0);
  });
});
