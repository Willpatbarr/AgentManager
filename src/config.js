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
  // DeskDashboard push (leave unset to disable).
  piIngestUrl: process.env.AM_PI_INGEST_URL ?? file.piIngestUrl ?? null,
  piPushIntervalSeconds: Number(process.env.AM_PI_PUSH_SEC ?? file.piPushIntervalSeconds ?? 5),
  // How often to collect queued Pi taps (the Pi can't reach a firewalled Mac,
  // so taps ride this Mac-initiated poll).
  piFocusPollSeconds: Number(process.env.AM_PI_POLL_SEC ?? file.piFocusPollSeconds ?? 1.5),
  // Optional board column overrides — see src/columns.js for the shape.
  columns: file.columns,
};
