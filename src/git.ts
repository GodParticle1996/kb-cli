/**
 * git.ts — optional auto-versioning of the wiki via git. The wiki directory
 * is its own git repo (initialized lazily on first commit) so that every
 * capture becomes a reviewable, diffable commit.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { Scope, SourceTool } from "./types.js";
import { rootFor } from "./storage.js";

export async function maybeCommitWiki(
  scope: Scope,
  message: string,
  opts: { autoCommit: boolean; cwd?: string } = { autoCommit: true },
  tool?: SourceTool,
): Promise<boolean> {
  if (!opts.autoCommit) return false;
  const root = rootFor(scope, opts.cwd, tool);
  const gitDir = join(root, ".git");
  let git = simpleGit(root);

  if (!existsSync(gitDir)) {
    try {
      await git.init();
      // Configure a local-only identity so commits succeed without global git config.
      await git.addConfig("user.name", "kb-cli");
      await git.addConfig("user.email", "kb@local");
    } catch {
      return false;
    }
  }

  try {
    await git.add(["-A"]);
    const status = await git.status();
    if (status.isClean()) return false;
    await git.commit(message);
    return true;
  } catch {
    return false;
  }
}
