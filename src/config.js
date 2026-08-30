import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadFileConfig() {
  const p = path.join(repoRoot, "config.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

const file = loadFileConfig();

export const config = {
  repoRoot,
  port: Number(process.env.AM_PORT ?? file.port ?? 8790),
  // The desktop app's live session index (org/user levels are globbed).
  sessionStoreDir:
    process.env.AM_SESSION_STORE ??
    file.sessionStoreDir ??
    path.join(os.homedir(), "Library/Application Support/Claude/claude-code-sessions"),
  projectsDir:
    process.env.AM_PROJECTS_DIR ?? file.projectsDir ?? path.join(os.homedir(), ".claude/projects"),
  // Sessions with no activity for this long are dropped from the board entirely.
  maxSessionAgeHours: Number(process.env.AM_MAX_AGE_HOURS ?? file.maxSessionAgeHours ?? 48),
  // Unseen-but-not-blocked sessions older than this stop being "needs-you".
  needsYouWindowMinutes: Number(process.env.AM_NEEDS_YOU_MIN ?? file.needsYouWindowMinutes ?? 120),
  // Mid-turn sessions with no transcript writes for this long get the "stalled" flag.
  stalledAfterSeconds: Number(process.env.AM_STALLED_SEC ?? file.stalledAfterSeconds ?? 120),
  // How often to re-run `ps` for process liveness. It costs ~60ms a spawn and
  // only feeds `hasProcess`, which doesn't change moment to moment, so there's
  // no reason to pay for it on every scan.
  processPollSeconds: Number(process.env.AM_PROCESS_POLL_SEC ?? file.processPollSeconds ?? 15),
  // How often to ask GitHub for PR review state. Only runs when some session
  // actually has an open PR, and never inside the scan — see src/prs.js.
  prPollSeconds: Number(process.env.AM_PR_POLL_SEC ?? file.prPollSeconds ?? 600),
  // How often to re-probe session directories for worktree-ness. A directory
  // does not stop being a worktree, so this can be slow; new paths are probed
  // immediately regardless.
  worktreePollSeconds: Number(process.env.AM_WORKTREE_POLL_SEC ?? file.worktreePollSeconds ?? 300),
  // DeskDashboard push (leave unset to disable).
  piIngestUrl: process.env.AM_PI_INGEST_URL ?? file.piIngestUrl ?? null,
  piPushIntervalSeconds: Number(process.env.AM_PI_PUSH_SEC ?? file.piPushIntervalSeconds ?? 5),
  // How often to collect queued Pi taps (the Pi can't reach a firewalled Mac,
  // so taps ride this Mac-initiated poll).
  piFocusPollSeconds: Number(process.env.AM_PI_POLL_SEC ?? file.piFocusPollSeconds ?? 1.5),
  // Which deep link a card tap sends. "hard" reaches the session (and reboots
  // the web app on the way, closing torn-off windows — see README). "soft" is
  // inert on Claude Desktop 1.24012.9: accepted without a warning, but the
  // window never changes session, so every tap becomes a silent no-op. Hence
  // OFF. Kept as a knob only because the routing is version-coupled and a
  // future build may start honouring the route.
  // Anything that isn't "soft" is coerced to "hard": a typo in an env var
  // shouldn't turn every tap into a no-op.
  focusLink: (process.env.AM_FOCUS_LINK ?? file.focusLink ?? "hard") === "soft" ? "soft" : "hard",
  // Torn-off Claude windows are destroyed whenever the main window follows a
  // session deep link, because that navigation reboots the renderer they are
  // registered against — and nothing in the URL can prevent it (the in-place
  // path depends on an internal per-webContents dispatcher no URL can conjure).
  //
  // Turning this ON makes a tap on some OTHER session skip the link rather than
  // take your windows with it. **Off by default**: the only way to protect the
  // windows is to not switch sessions, and losing click-to-focus is a worse
  // trade than losing the windows. Set AM_PROTECT_POPOUTS=1 if you disagree.
  protectPopouts: (process.env.AM_PROTECT_POPOUTS ?? file.protectPopouts ?? "0") === "1",
  // Optional board column overrides — see src/columns.js for the shape.
  columns: file.columns,
};
