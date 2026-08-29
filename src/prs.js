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

/** repo -> Map<prNumber, { reviewDecision, isDraft }> */
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

async function fetchRepoReviewState(repo) {
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "pr", "list",
        "--repo", repo,
        "--author", "@me",
        "--state", "open",
        "--json", "number,reviewDecision,isDraft",
        "--limit", "100",
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const next = new Map();
    for (const pr of JSON.parse(stdout)) {
      next.set(Number(pr.number), {
        reviewDecision: pr.reviewDecision || null,
        isDraft: Boolean(pr.isDraft),
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
