/**
 * commands/capture-runner.ts — thin wrapper that builds providers, resolves the
 * active one, and runs the extraction pipeline. Kept separate from capture.ts
 * so the runner can be unit-tested without CLI arg parsing.
 */
import type { CaptureResult, KbConfig } from "../types.js";
import { runPipeline } from "../extractor/pipeline.js";
import { buildProviders, getProvider } from "../providers/index.js";

export interface RunCaptureInput {
  raw: string;
  label?: string;
  /** Which tool produced the session (claude|kimi|opencode|codex|cline). */
  tool?: string;
  /** Optional task slug the capture belongs to. */
  task?: string;
  config: KbConfig;
  cwd?: string;
}

export async function runCapture(input: RunCaptureInput): Promise<CaptureResult> {
  const providers = buildProviders(input.config);
  const { provider } = getProvider(input.config, providers);
  return runPipeline({
    raw: input.raw,
    sessionLabel: input.label,
    tool: input.tool,
    task: input.task,
    provider,
    config: input.config,
    cwd: input.cwd,
  });
}
