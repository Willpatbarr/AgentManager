/**
 * Where a session sits in the work lifecycle.
 *
 * Pure function of the desktop app's `local_*.json` — no transcript read, no
 * network, no side effects. Everything here was already on disk and unread.
 */

/** Stage ids, in lifecycle order. */
export const STAGES = ["planning", "implementing", "review", "done"];

/**
 * First match wins.
 *
 * `permissionMode === "plan"` leads deliberately: it says what the session is
 * doing *right now*, and outranks history like a `planPath` left over from a
 * plan that was already implemented.
 */
export function stageFor(meta) {
  if (meta?.permissionMode === "plan") return "planning";

  const prs = pullRequests(meta);
  if (prs.some((pr) => pr?.state === "OPEN")) return "review";
  if (prs.length) return "done"; // every PR merged or closed

  if (Array.isArray(meta?.writtenBranches) && meta.writtenBranches.length) return "implementing";
  if (meta?.planPath) return "planning";
  return "implementing";
}

/** `prs[]` as an array, whatever the metadata actually holds. */
export function pullRequests(meta) {
  return Array.isArray(meta?.prs) ? meta.prs : [];
}

/**
 * The PR this session is about: the first OPEN one, else the most recent.
 *
 * Prefers `prs[]` over the legacy top-level `prNumber`/`prUrl`/`prState`
 * scalars, which only duplicate `prs[0]` and go stale once a session opens a
 * second PR.
 */
export function primaryPullRequest(meta) {
  const prs = pullRequests(meta);
  if (!prs.length) return null;
  return prs.find((pr) => pr?.state === "OPEN") ?? prs[prs.length - 1];
}
