import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { refreshWorktrees, worktreeInfo } from "./worktrees.js";
import {
  ATTENTION_COLORS,
  ATTENTION_RANK,
  attentionFor,
  columnDefs,
  columnFor,
} from "./columns.js";
import { analyzeTranscript, resolveTranscript } from "./transcript.js";
import { primaryPullRequest, pullRequests, stageFor } from "./stage.js";
import { refreshReviewStateIfStale, reviewStateFor } from "./prs.js";

const execFileP = promisify(execFile);

function listSessionMetadataFiles() {
  const out = [];
  let orgs = [];
  try {
    orgs = fs.readdirSync(config.sessionStoreDir);
  } catch {
    return out;
  }
  for (const org of orgs) {
    const orgDir = path.join(config.sessionStoreDir, org);
    let users;
    try {
      users = fs.readdirSync(orgDir);
    } catch {
      continue;
    }
    for (const user of users) {
      const userDir = path.join(orgDir, user);
      let files;
      try {
        files = fs.readdirSync(userDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.startsWith("local_") && f.endsWith(".json")) out.push(path.join(userDir, f));
      }
    }
  }
  return out;
}

/**
 * Parsed `local_*.json` keyed by path, invalidated by mtime.
 *
 * These files are rewritten rarely but were re-read and re-parsed on every
 * scan, which was the single largest cost in a scan. Entries are pruned when
 * their file disappears so the cache can't outlive the sessions it describes.
 * The parsed objects are shared across scans — treat them as read-only.
 */
const metadataCache = new Map();

/** Parse every metadata file, reusing the previous parse when it hasn't changed. */
function readSessionMetadata(files) {
  const present = new Set(files);
  for (const key of metadataCache.keys()) {
    if (!present.has(key)) metadataCache.delete(key);
  }

  const metas = [];
  for (const file of files) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      metadataCache.delete(file);
      continue;
    }

    const cached = metadataCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      metas.push(cached.meta);
      continue;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(file, "utf-8"));
      metadataCache.set(file, { mtimeMs, meta });
      metas.push(meta);
    } catch {
      metadataCache.delete(file);
    }
  }
  return metas;
}

/** cliSessionIds that have a live claude process (via --resume=<id> on the command line). */
async function liveCliSessionIds() {
  const resumed = new Set();
  try {
    const { stdout } = await execFileP("ps", ["-axo", "command"], { maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      if (!line.includes("claude.app/Contents/MacOS/claude")) continue;
      if (line.includes("/Helpers/disclaimer ")) continue; // wrapper, child repeats the args
      const m = line.match(/--resume[= ]([0-9a-f-]{36})/);
      if (m) resumed.add(m[1]);
    }
  } catch {
    /* ps failed; fall back to activity-based liveness */
  }
  return resumed;
}

function truthy(v) {
  return v === true || v === "True" || v === "true";
}

/** Last `ps` result, reused until it ages past `config.processPollSeconds`. */
let processLiveness = { checkedAt: 0, resumed: new Set() };

/** Process liveness on its own cadence — see `config.processPollSeconds`. */
async function resumedSessionIds(now) {
  if (now - processLiveness.checkedAt < config.processPollSeconds * 1000) {
    return processLiveness.resumed;
  }
  const resumed = await liveCliSessionIds();
  processLiveness = { checkedAt: now, resumed };
  return resumed;
}

export async function scanSessions() {
  const now = Date.now();
  const maxAgeMs = config.maxSessionAgeHours * 3600 * 1000;
  const resumed = await resumedSessionIds(now);

  const sessions = [];
  const openPrRepos = new Set();
  // Directories to probe for worktree-ness: a session's own `cwd`, which for a
  // worktree session is the worktree itself.
  const probeCwds = [];
  for (const meta of readSessionMetadata(listSessionMetadataFiles())) {
    if (truthy(meta.isArchived)) continue;

    const lastMetaActivity = Number(meta.lastActivityAt ?? 0);
    const cliId = meta.cliSessionId;
    const transcript = cliId ? resolveTranscript(meta.cwd, cliId) : null;

    // Age-gate on the transcript's mtime *before* reading its contents. Most
    // sessions on disk are far older than the board's window, and analyzing
    // one costs a 512 KB tail read plus a JSON parse per line — work that was
    // being thrown away by the age check immediately below it.
    // mtime is a valid *upper* bound on activity — a file can't be touched
    // before its content is written — so it still safely skips the 512 KB read
    // for sessions that are definitely old. It is not an activity clock,
    // though: opening a session rewrites its trailing sidecar records. The real
    // gate runs below, once the transcript's own timestamps are available.
    const mtimeBound = Math.max(lastMetaActivity, transcript?.mtimeMs ?? 0);
    if (!mtimeBound || now - mtimeBound > maxAgeMs) continue;

    const analysis = transcript ? analyzeTranscript(transcript.path) : null;

    // Re-gate on the *true* activity clock now that the transcript is parsed.
    // The mtime gate above only proved this session might be recent; a session
    // merely opened and never worked has a fresh mtime and an ancient last turn.
    const lastActivityAt = Math.max(lastMetaActivity, analysis?.lastRecordAt ?? 0);
    if (!lastActivityAt || now - lastActivityAt > maxAgeMs) continue;

    const ageMs = now - lastActivityAt;
    const turnOpen = analysis?.turnOpen ?? false;

    const pr = pullRequestFacet(meta);
    if (pr?.state === "OPEN" && pr.repo) openPrRepos.add(pr.repo);

    // A pending question or plan approval outranks a review verdict: it's the
    // more immediate gate, and the agent is literally stopped on it.
    const blockedOn =
      analysis?.blockedOn ?? (pr?.reviewDecision === "CHANGES_REQUESTED" ? "changes-requested" : null);

    const session = {
      id: meta.sessionId,
      cliSessionId: cliId ?? null,
      title:
        meta.title || analysis?.customTitle || analysis?.aiTitle || analysis?.lastPrompt || "Untitled",
      stage: stageFor(meta),

      // Attention signals stay flat: column rules read these constantly, and
      // `s.blocked` reads better than `s.attention.blocked`.
      turnOpen,
      blocked: blockedOn !== null,
      blockedOn,
      unseen: lastActivityAt > Number(meta.lastFocusedAt ?? 0),
      stalled: turnOpen && ageMs > config.stalledAfterSeconds * 1000,
      hasProcess: cliId ? resumed.has(cliId) : false,
      // Derived alias, retained so the Pi's Swift decoder keeps working
      // untouched (PushIngest.swift reads `askPending`).
      askPending: blockedOn === "question",

      // Descriptive facets.
      project: projectFacet(meta, pr),
      pr,
      plan: planFacet(meta),

      agents: analysis?.agents ?? [],
      // The fuller history behind `agents`: finished runs as well as in-flight
      // ones, for the Pi's session detail panel. `agents` stays "right now".
      agentRuns: analysis?.agentRuns ?? [],
      model: meta.model ?? null,
      effort: meta.effort ?? null,
      permissionMode: meta.permissionMode ?? null,

      lastActivity: analysis?.lastActivity ?? null,
      lastActivityAt,
      lastFocusedAt: Number(meta.lastFocusedAt ?? 0) || null,
      ageSeconds: Math.round(ageMs / 1000),
    };
    // Which column it lands in, and — separately — what it would be called if
    // the PR column didn't exist. The Pi paints the card's dot with the second.
    if (meta.cwd) probeCwds.push(meta.cwd);
    session.state = columnFor(session);
    session.attention = attentionFor(session);
    // Did this session actually write code? `writtenBranches` is per-SESSION,
    // unlike the checkout's current branch (a property of the folder, shared by
    // every session that ever ran there). It is the positive "implementing"
    // signal the stage ladder never had — the ladder's own rule for it is
    // unreachable, because anything with a branch also has a PR by then.
    session.touchedCode = Array.isArray(meta.writtenBranches) && meta.writtenBranches.length > 0;
    session.attentionColor = ATTENTION_COLORS[session.attention] ?? null;
    sessions.push(session);
  }

  // Out-of-band and lazy: no open PR anywhere means no `gh` process at all.
  // Never awaited — one call takes ~1.5s and this loop runs every 2s.
  refreshReviewStateIfStale([...openPrRepos], now);

  // Probe any new session directories for worktree-ness. Detached: the scan
  // reads whatever the cache already holds (same contract as `prs.js`).
  refreshWorktrees(probeCwds);

  const rank = new Map(columnDefs.map((c, i) => [c.id, i]));
  // Column first, then ATTENTION — so a column reads hottest-first: the ones
  // waiting on you, then the ones running, then the quiet ones — and recency
  // inside each of those.
  sessions.sort(
    (a, b) =>
      (rank.get(a.state) ?? 99) - (rank.get(b.state) ?? 99) ||
      (ATTENTION_RANK[a.attention] ?? 9) - (ATTENTION_RANK[b.attention] ?? 9) ||
      b.lastActivityAt - a.lastActivityAt,
  );
  return { updatedAt: now, columns: columnDefs, sessions };
}

/**
 * Where the session's work lives.
 *
 * `originCwd` rather than `cwd`: a worktree session's `cwd` is the throwaway
 * worktree directory, so it used to label itself `focused-clarke-68e02b`
 * instead of the repo it's actually working on. (The previous implementation
 * read `userSelectedFolders`, a key that appears in 0 of 215 metadata files —
 * the branch was dead and its guard could never fire.)
 */
function projectFacet(meta, pr) {
  const origin = meta.originCwd ?? meta.cwd ?? null;
  // Sessions with no chosen folder run inside the app's own session dir.
  const isInternal = origin ? origin.includes("Application Support/Claude") : true;
  return {
    name: origin && !isInternal ? path.basename(origin) : null,
    path: origin,
    repo: pr?.repo ?? meta.prRepository ?? null,
    branch: meta.branch ?? null,
    base: meta.sourceBranch ?? pr?.base ?? null,
    // Git, not metadata: the desktop app never records `worktreePath` (0 of
    // 215 files), but a session's own `cwd` tells git everything. `cwd` and
    // not `originCwd` — the throwaway worktree directory IS the thing being
    // asked about here, even though the label above wants the repo it came
    // from. `exists: false` means the worktree has since been deleted.
    worktree: worktreeInfo(meta.cwd ?? origin).isWorktree,
    worktreeGone: worktreeInfo(meta.cwd ?? origin).exists === false,
  };
}

/**
 * The PR this session is about, with GitHub review state merged in from the cache.
 *
 * Takes the desktop app's word for it. There WAS a guard here that dropped a PR
 * whose repo didn't match the session directory's origin remote, to stop a
 * session that had moved repos from advertising a stale PR (it had one live: a
 * session moved from MemberTools to AgentManager and kept showing MemberTools'
 * #2070).
 *
 * It cost more than it caught. Opening a PR in a repo OTHER than the one the
 * session sits in is ordinary — a session working in DeskDashboard that opens a
 * PR against AgentManager is doing exactly that — and the guard silently
 * dropped those, so the session fell out of the PR column with nothing to say
 * why. `cwd` and `originCwd` are both the session's own directory, so neither
 * can tell "moved on" apart from "worked across two repos".
 *
 * A stale PR is visible and fixable (drop the folder in the desktop app); a PR
 * that vanishes for an unexplained reason is neither.
 */
function pullRequestFacet(meta) {
  const source = primaryPullRequest(meta);
  if (!source) return null;
  const repo = source.repo ?? meta.prRepository ?? null;
  const number = source.prNumber ?? null;
  const review = reviewStateFor(repo, number);
  return {
    number,
    url: source.url ?? null,
    repo,
    branch: source.branch ?? null,
    base: source.baseRef ?? null,
    state: source.state ?? null,
    reviewDecision: review?.reviewDecision ?? null,
    isDraft: review?.isDraft ?? false,
  };
}

/** The plan document this session was started from, if any. */
function planFacet(meta) {
  if (!meta.planPath) return null;
  return {
    path: meta.planPath,
    name: path.basename(String(meta.planPath)).replace(/\.[^.]+$/, ""),
  };
}
