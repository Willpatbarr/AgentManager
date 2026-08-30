/**
 * GitHub review state for the PRs your open sessions are attached to.
 *
 * The desktop app records a PR's `state` (OPEN/MERGED/CLOSED) but not its
 * *review* state, so "changes requested" — the one PR signal that actually
 * needs you — is invisible locally. That fact only exists on GitHub, so this is
 * the one place the board reaches off-machine.
 *
 * Two rules keep that honest:
 *   1. Lazy. No session with an OPEN pr means no repos, which means no process
 *      is spawned at all.
 *   2. Out-of-band. `gh` takes ~1.5s and the scan loop runs every 2s, so the
 *      scan only ever *reads the cache*; refreshes run detached.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileP = promisify(execFile);

/** repo -> Map<prNumber, { reviewDecision, isDraft, author }> */
const reviewState = new Map();
let checkedAt = 0;
let inFlight = null;

/**
 * Review state for one PR, or null if it's never been fetched successfully.
 * A pure cache read — safe to call from inside the scan loop.
 */
export function reviewStateFor(repo, number) {
  if (!repo || number === null || number === undefined) return null;
  return reviewState.get(repo)?.get(Number(number)) ?? null;
}

/**
 * Start a refresh if the cache has gone stale. Returns immediately and is never
 * awaited by the scan — a slow or hanging `gh` must not be able to stall the
 * board. Concurrent scans collapse onto the one in-flight refresh.
 */
export function refreshReviewStateIfStale(repos, now = Date.now()) {
  if (!repos.length) return; // nothing open anywhere: spawn nothing
  if (inFlight) return;
  if (now - checkedAt < config.prPollSeconds * 1000) return;

  checkedAt = now; // set before fetching, so a failure backs off rather than hammering
  inFlight = Promise.all(repos.map(fetchRepoReviewState))
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
}

/**
 * Every GitHub login this machine is signed in as, lowercased.
 *
 * Read once from `gh auth status`, which lists ALL logged-in accounts rather
 * than just the active one. Empty when it can't be read — and `isYours` then
 * accepts everything, so a parsing failure degrades to trusting the repo
 * listing rather than to attributing nothing.
 */
let logins = null;

async function knownLogins() {
  if (logins) return logins;
  try {
    const { stdout } = await execFileP("gh", ["auth", "status"], { timeout: 10_000 });
    logins = new Set([...stdout.matchAll(/account (\S+)/g)].map((m) => m[1].toLowerCase()));
  } catch {
    logins = new Set();
  }
  return logins;
}

/** Whether a PR was opened by one of this machine's accounts. */
export function isYours(author) {
  if (!logins || !logins.size) return true;
  return logins.has(String(author ?? "").toLowerCase());
}

async function fetchRepoReviewState(repo) {
  await knownLogins();
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "pr", "list",
        "--repo", repo,
        // NOT `--author @me`. That resolves against whichever account `gh` is
        // currently switched to, so on a machine with a work login and a
        // personal one it silently hides every PR opened by the other — and
        // "changes requested", the one PR signal that actually needs you, went
        // missing on half this machine's repos. Ownership is decided by
        // `isYours` against every logged-in account instead.
        "--state", "open",
        "--json", "number,reviewDecision,isDraft,author",
        "--limit", "100",
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const next = new Map();
    for (const pr of JSON.parse(stdout)) {
      next.set(Number(pr.number), {
        reviewDecision: pr.reviewDecision || null,
        isDraft: Boolean(pr.isDraft),
        author: pr.author?.login || null,
      });
    }
    reviewState.set(repo, next);
    if (process.env.AM_VERBOSE) console.log(`[prs] ${repo}: ${next.size} open PRs`);
  } catch (err) {
    // Deliberately keep the last known state. A flaky network or an expired
    // token must not silently clear a changes-requested flag and un-block a
    // session that still needs you.
    if (process.env.AM_VERBOSE) console.error(`[prs] ${repo}: ${err.message}`);
  }
}
