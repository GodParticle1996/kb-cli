/**
 * extractor/chunker.ts — split raw session text into chunks sized for the
 * extraction LLM's context window.
 *
 * Strategy:
 *  - Split on blank-line-separated "turn" boundaries first.
 *  - Greedily pack turns into chunks up to `maxChars`.
 *  - If a single turn exceeds `maxChars`, split it on newlines.
 *  - The most recent content matters most, so the pipeline can prioritize
 *    later chunks; here we just return chunks in document order.
 */
export interface Chunk {
  index: number;
  text: string;
  chars: number;
}

/** Default chunk size in characters (~ maps to a few thousand tokens). */
export const DEFAULT_CHUNK_CHARS = 12000;

export function chunkText(raw: string, maxChars: number = DEFAULT_CHUNK_CHARS): Chunk[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return [];

  // Split into turns on double-newlines; keep single-newline turns intact.
  const turns = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);

  const chunks: Chunk[] = [];
  let buf = "";
  let bufChars = 0;

  const flush = (): void => {
    if (buf.length > 0) {
      chunks.push({ index: chunks.length, text: buf, chars: bufChars });
      buf = "";
      bufChars = 0;
    }
  };

  for (const turn of turns) {
    if (turn.length > maxChars) {
      flush();
      // Hard-split an oversized turn on newlines, then by chars as a last resort.
      let acc = "";
      for (const line of turn.split("\n")) {
        if ((acc + "\n" + line).length > maxChars) {
          if (acc) {
            chunks.push({ index: chunks.length, text: acc, chars: acc.length });
            acc = "";
          }
          if (line.length > maxChars) {
            for (let i = 0; i < line.length; i += maxChars) {
              const slice = line.slice(i, i + maxChars);
              chunks.push({ index: chunks.length, text: slice, chars: slice.length });
            }
          } else {
            acc = line;
          }
        } else {
          acc = acc ? acc + "\n" + line : line;
        }
      }
      if (acc) {
        chunks.push({ index: chunks.length, text: acc, chars: acc.length });
      }
      continue;
    }

    if (bufChars + turn.length + 2 > maxChars) {
      flush();
      buf = turn;
      bufChars = turn.length;
    } else {
      buf = buf ? buf + "\n\n" + turn : turn;
      bufChars = buf.length;
    }
  }
  flush();
  return chunks;
}

/**
 * Drop low-signal chunks (mostly tool noise / ANSI escapes) to save tokens.
 * Keeps any chunk that has at least one alphabetic sentence of decent length.
 */
export function filterSignalChunks(chunks: Chunk[]): Chunk[] {
  return chunks
    .map((c) => ({ ...c, text: stripAnsi(c.text) }))
    .filter((c) => /[A-Za-z][A-Za-z ]{15,}/.test(c.text))
    .map((c, i) => ({ ...c, index: i }));
}

/** Remove ANSI escape sequences and common terminal control noise. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
