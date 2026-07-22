/**
 * vectors/store.ts — vector store backed by LanceDB (embedded, no server).
 *
 * LanceDB v0.31 infers the table schema from the first batch of data rows,
 * so we pass plain objects (including a `vector` number[] field). This avoids
 * manual Arrow schema construction and naturally handles whatever embedding
 * dimension the configured mode produces.
 *
 * Falls back to an in-memory JSON sidecar store if LanceDB's native module
 * fails to load, so kb never hard-crashes where the native binary is missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedFact, KbConfig, Scope, SourceTool, VectorRow } from "../types.js";
import { vectorsDir } from "../storage.js";
import { embedText, cosine } from "./embed.js";
import { getEmbeddingProvider } from "../providers/index.js";

const TABLE = "kb_vectors";
const SIDECAR = "vectors.json";

// We import LanceDB lazily and dynamically so a missing/broken native module
// never breaks the rest of the CLI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConnection = any;

async function connectLance(dir: string): Promise<AnyConnection | null> {
  try {
    const lancedb = await import("@lancedb/lancedb");
    return await lancedb.connect(dir);
  } catch {
    return null;
  }
}

async function getOrCreateTable(
  db: AnyConnection,
  firstRow: Record<string, unknown>,
): Promise<{ table: AnyTable; existed: boolean } | null> {
  try {
    const tables = await db.tableNames();
    if (tables.includes(TABLE)) {
      return { table: await db.openTable(TABLE), existed: true };
    }
    // Schema is inferred from the first row (must be non-empty).
    return { table: await db.createTable(TABLE, [firstRow]), existed: false };
  } catch {
    return null;
  }
}

function rowToRecord(r: VectorRow): Record<string, unknown> {
  return {
    id: r.id,
    vector: r.vector,
    text: r.text,
    category: r.category,
    wikiFile: r.wikiFile,
    source: r.source,
    tool: r.tool ?? "unattributed",
    timestamp: r.timestamp,
    scope: r.scope,
  };
}

/** Index a batch of facts into the vector store. Returns count stored. */
export async function indexVectors(
  scope: Scope,
  facts: ExtractedFact[],
  config: KbConfig,
  cwd?: string,
  tool?: SourceTool,
): Promise<number> {
  if (facts.length === 0) return 0;
  const dir = vectorsDir(scope, cwd, tool);
  mkdirSync(dir, { recursive: true });
  const provider = getEmbeddingProvider(config);

  const rows: VectorRow[] = [];
  for (const fact of facts) {
    const { vector } = await embedText(
      `${fact.content} ${fact.rationale ?? ""}`,
      config,
      provider,
    );
    rows.push({
      id: fact.id,
      vector,
      text: fact.content,
      category: fact.category,
      wikiFile: fact.wikiFile ?? categoryDefaultFile(fact.category),
      source: fact.source,
      tool: fact.tool,
      timestamp: fact.timestamp,
      scope,
    });
  }

  const db = await connectLance(dir);
  if (db) {
    try {
      const handle = await getOrCreateTable(db, rowToRecord(rows[0]));
      if (handle) {
        // Upsert by id: when the table already existed, drop any rows that
        // share an id with the incoming batch so re-captures don't accumulate
        // duplicates, then insert all rows. When newly created, rows[0] was
        // already inserted by createTable, so add only the remaining rows.
        if (handle.existed) {
          try {
            const pred = `id IN (${rows
              .map((r) => `'${String(r.id).replace(/'/g, "''")}'`)
              .join(",")})`;
            await handle.table.delete(pred);
          } catch {
            // If delete isn't supported, the subsequent add may duplicate;
            // acceptable degradation rather than dropping the capture.
          }
        }
        const toAdd = handle.existed ? rows : rows.slice(1);
        if (toAdd.length > 0) {
          await handle.table.add(toAdd.map(rowToRecord));
        }
        return rows.length;
      }
    } catch {
      // fall through to memory store
    }
  }
  appendMemory(dir, rows);
  return rows.length;
}

export interface SearchHit {
  id: string;
  text: string;
  category: string;
  wikiFile: string;
  source: string;
  tool: string;
  timestamp: string;
  score: number;
}

/** Semantic search across one scope's vectors. */
export async function searchVectors(
  scope: Scope,
  query: string,
  config: KbConfig,
  opts: { max: number; cwd?: string; tool?: string },
): Promise<SearchHit[]> {
  const dir = vectorsDir(scope, opts.cwd, opts.tool as SourceTool | undefined);
  if (!existsSync(dir)) return [];
  const provider = getEmbeddingProvider(config);
  const { vector } = await embedText(query, config, provider);

  const db = await connectLance(dir);
  if (db) {
    try {
      const tables = await db.tableNames();
      if (!tables.includes(TABLE)) return [];
      const table = await db.openTable(TABLE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let results: any[];
      if (opts.tool) {
        // Apply a tool filter when one is requested. LanceDB's .where() uses
        // SQL-style predicates; we keep it as a best-effort that falls back to
        // the unfiltered search if filtering fails.
        try {
          results = await table.search(vector).where(`tool = '${opts.tool}'`).limit(opts.max).toArray();
        } catch {
          results = await table.search(vector).limit(opts.max).toArray();
        }
      } else {
        results = await table.search(vector).limit(opts.max).toArray();
      }
      return results.map((r: Record<string, unknown>) => ({
        id: String(r.id ?? ""),
        text: String(r.text ?? ""),
        category: String(r.category ?? "note"),
        wikiFile: String(r.wikiFile ?? ""),
        source: String(r.source ?? ""),
        tool: String(r.tool ?? "unattributed"),
        timestamp: String(r.timestamp ?? ""),
        score:
          typeof r._distance === "number"
            ? 1 / (1 + (r._distance as number))
            : 1,
      }));
    } catch {
      // fall through to memory store
    }
  }
  return searchMemory(dir, vector, opts.max, opts.tool);
}

/** Count stored vectors for a scope (best-effort). */
export async function countVectors(scope: Scope, cwd?: string, tool?: SourceTool): Promise<number> {
  const dir = vectorsDir(scope, cwd, tool);
  if (!existsSync(dir)) return 0;
  const db = await connectLance(dir);
  if (db) {
    try {
      const tables = await db.tableNames();
      if (!tables.includes(TABLE)) return 0;
      const table = await db.openTable(TABLE);
      return await table.countRows();
    } catch {
      // ignore
    }
  }
  return readMemory(dir).rows.length;
}

function categoryDefaultFile(category: string): string {
  const map: Record<string, string> = {
    decision: "decisions-log.md",
    architecture: "architecture.md",
    pattern: "patterns.md",
    bugfix: "bugs-and-fixes.md",
    "file-change": "project-state.md",
    state: "project-state.md",
    "open-question": "open-questions.md",
    note: "project-state.md",
  };
  return map[category] ?? "project-state.md";
}

// ---- In-memory JSON sidecar fallback ----

function sidecarPath(dir: string): string {
  return join(dir, SIDECAR);
}

function readMemory(dir: string): { rows: VectorRow[] } {
  const p = sidecarPath(dir);
  if (!existsSync(p)) return { rows: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { rows: VectorRow[] };
  } catch {
    return { rows: [] };
  }
}

function appendMemory(dir: string, rows: VectorRow[]): void {
  const store = readMemory(dir);
  const existing = new Set(store.rows.map((r) => r.id));
  for (const r of rows) {
    if (!existing.has(r.id)) store.rows.push(r);
  }
  writeFileSync(sidecarPath(dir), JSON.stringify(store), "utf8");
}

function searchMemory(dir: string, query: number[], max: number, tool?: string): SearchHit[] {
  const store = readMemory(dir);
  const scored = store.rows
    .filter((r) => (tool ? (r.tool ?? "unattributed") === tool : true))
    .map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      wikiFile: r.wikiFile,
      source: r.source,
      tool: r.tool ?? "unattributed",
      timestamp: r.timestamp,
      score: cosine(query, r.vector),
    }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}
