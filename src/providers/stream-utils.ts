/**
 * providers/stream-utils.ts — shared streaming helpers used by all providers.
 *
 * Reasoning models (GLM 5.2, DeepSeek V4 Pro, etc.) stream their "thinking"
 * phase via `reasoning_content` rather than `content`. This utility captures
 * reasoning tokens and writes them to stderr so the terminal doesn't appear
 * frozen during the thinking phase.
 */

/** A single delta chunk from a streaming response. */
interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
}

/**
 * Yield content tokens from a streaming response, pipelining any reasoning
 * tokens to stderr with a "💭 thinking..." header so the user sees activity.
 *
 * @param stream — async iterable of OpenAI-compatible streaming chunks
 */
export async function* yieldStreamWithReasoning(
  stream: AsyncIterable<{ choices?: Array<{ delta?: StreamDelta }> }>,
): AsyncIterable<string> {
  let thinking = false;

  for await (const chunk of stream) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delta = chunk.choices?.[0]?.delta as StreamDelta | undefined;
    if (!delta) continue;

    const reasoning = delta.reasoning_content;
    const content = delta.content;

    if (reasoning) {
      if (!thinking) {
        process.stderr.write("\n  💭 thinking...\n");
        thinking = true;
      }
      process.stderr.write(reasoning);
    }

    if (content) {
      if (thinking) {
        process.stderr.write("\n\n");
        thinking = false;
      }
      yield content;
    }
  }

  if (thinking) {
    process.stderr.write("\n");
  }
}
