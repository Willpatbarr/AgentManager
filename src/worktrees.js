/**
 * Whether a session's directory is a linked git worktree.
 *
 * The desktop app records `cwd` for every session but never `worktreePath` or
 * `branch`, so this is the one fact that has to come from git rather than from
 * `local_*.json`. It is worth asking for: a worktree path belongs to exactly
 * one ticket, which makes it a genuinely per-session signal — unlike the
 * checkout's current branch, which is a property of the FOLDER and is shared by
 * every session that ever ran there.
 *
 * Cheap because it is cached per directory and a directory does not stop being
 * a worktree. Two rules, the same ones `prs.js` follows:
 *   1. Lazy — only paths actually in use are probed, and only once per TTL.
 *   2. Out-of-band — the scan reads the cache; refreshes run detached, so a
 *      slow or hung `git` can never stall the 2s loop.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { config } from "./config.js";

const execFileP = promisify(execFile);

/** cwd -> { isWorktree, exists, repos } */
const cache = new Map();
let checkedAt = 0;
let inFlight = null;

/**
 * What we know about a directory. A pure cache read — safe inside the scan.
 * Unknown paths report `isWorktree: false`, so the board degrades to "not a
 * worktree" rather than to an error.
 */
export function worktreeInfo(cwd) {
  return cache.get(cwd) ?? { isWorktree: false, exists: true, repos: [] };
}

/**
 * Every GitHub repo this directory has a remote for, as `owner/name`, or NULL
 * if the directory hasn't been probed yet. The nil-vs-empty distinction is
 * load-bearing: "no remotes" is an answer, "not asked yet" is not, and only the
 * former may be used to reject a PR.
 *
 * ALL remotes, not just `origin`: this repo's own MemberTools checkout has
 * origin pointing at a personal FORK while its PRs live upstream at
 * `ICS-Eng/...`, so an origin-only check rejects perfectly good PRs.
 */
export function remotesFor(cwd) {
  const entry = cache.get(cwd);
  return entry ? entry.repos : null;
}

/** `owner/name` from any of the URL forms git remotes come in. */
export function parseRemote(url) {
  if (!url) return null;
  const m = url.match(/(?:github\.com[:/])([^/]+)\/([^\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Every distinct `owner/name` in `git remote -v` output. */
export function parseRemotes(text) {
  const found = new Set();
  for (const line of (text ?? "").split("\n")) {
    const url = line.split(/\s+/)[1];
    const repo = parseRemote(url);
    if (repo) found.add(repo);
  }
  return [...found];
}

/**
 * Probe any directories we haven't seen, if the cache has gone stale. Returns
 * immediately; never awaited by the scan.
 */
export function refreshWorktrees(cwds) {
  const wanted = [...new Set(cwds.filter(Boolean))];
  const unseen = wanted.filter((c) => !cache.has(c));
  const now = Date.now();
  // Refresh on the cadence, but probe a brand-new path right away — a session
  // that just moved into a worktree shouldn't wait out the TTL to be placed.
  if (!unseen.length && now - checkedAt < config.worktreePollSeconds * 1000) return;
  if (inFlight) return;

  checkedAt = now;
  inFlight = (async () => {
    for (const cwd of wanted) {
      try {
        if (!fs.existsSync(cwd)) {
          // A deleted worktree: the session's directory is simply gone.
          cache.set(cwd, { isWorktree: false, exists: false, repos: [] });
          continue;
        }
        // A linked worktree's own git dir differs from the repo's common one;
        // in a normal checkout they are the same directory.
        const [gitDir, commonDir, origin] = await Promise.all([
          git(cwd, "rev-parse", "--absolute-git-dir"),
          git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
          git(cwd, "remote", "-v").catch(() => ""),
        ]);
        cache.set(cwd, {
          isWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir),
          exists: true,
          repos: parseRemotes(origin),
        });
      } catch {
        // Not a repo, or git unavailable. Keeping any previous answer beats
        // clearing one on a transient failure.
        if (!cache.has(cwd)) cache.set(cwd, { isWorktree: false, exists: true, repos: [] });
      }
    }
    inFlight = null;
  })();
  inFlight.catch(() => {
    inFlight = null;
  });
}

async function git(cwd, ...args) {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: 4000 });
  return stdout.trim();
}
