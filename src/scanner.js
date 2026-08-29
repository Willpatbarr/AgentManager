import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { columnDefs, columnFor } from "./columns.js";
import { analyzeTranscript, transcriptPathFor } from "./transcript.js";

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

/** cliSessionIds that have a live claude process (via --resume=<id> on the command line). */
async function liveCliSessionIds() {
  const resumed = new Set();
  let liveProcessCount = 0;
  try {
    const { stdout } = await execFileP("ps", ["-axo", "command"], { maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      if (!line.includes("claude.app/Contents/MacOS/claude")) continue;
      if (line.includes("/Helpers/disclaimer ")) continue; // wrapper, child repeats the args
      liveProcessCount++;
      const m = line.match(/--resume[= ]([0-9a-f-]{36})/);
      if (m) resumed.add(m[1]);
    }
  } catch {
    /* ps failed; fall back to activity-based liveness */
  }
  return { resumed, liveProcessCount };
}

function truthy(v) {
  return v === true || v === "True" || v === "true";
}

export async function scanSessions() {
  const now = Date.now();
  const maxAgeMs = config.maxSessionAgeHours * 3600 * 1000;
  const { resumed } = await liveCliSessionIds();

  const sessions = [];
  for (const file of listSessionMetadataFiles()) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (truthy(meta.isArchived)) continue;

    const lastMetaActivity = Number(meta.lastActivityAt ?? 0);
    const cliId = meta.cliSessionId;
    const transcript = cliId ? transcriptPathFor(meta.cwd, cliId) : null;
    const analysis = transcript ? analyzeTranscript(transcript) : null;

    const lastActivityMs = Math.max(lastMetaActivity, analysis?.mtimeMs ?? 0);
    if (!lastActivityMs || now - lastActivityMs > maxAgeMs) continue;

    const hasProcess = cliId ? resumed.has(cliId) : false;
    const ageMs = now - lastActivityMs;

    // Raw signals; the column engine (src/columns.js) decides the lane.
    const session = {
      id: meta.sessionId,
      cliSessionId: cliId ?? null,
      title:
        meta.title || analysis?.customTitle || analysis?.aiTitle || analysis?.lastPrompt || "Untitled",
      project: folderLabel(meta, analysis),
      cwd: meta.cwd ?? null,
      model: meta.model ?? null,
      turnOpen: analysis?.turnOpen ?? false,
      stalled: (analysis?.turnOpen ?? false) && ageMs > config.stalledAfterSeconds * 1000,
      hasProcess,
      askPending: analysis?.askPending ?? false,
      agents: analysis?.agents ?? [],
      lastActivity: analysis?.lastActivity ?? null,
      lastActivityAt: lastActivityMs,
      ageSeconds: Math.round(ageMs / 1000),
    };
    session.state = columnFor(session);
    sessions.push(session);
  }

  const rank = new Map(columnDefs.map((c, i) => [c.id, i]));
  sessions.sort(
    (a, b) => (rank.get(a.state) ?? 99) - (rank.get(b.state) ?? 99) || b.lastActivityAt - a.lastActivityAt,
  );
  return { updatedAt: now, columns: columnDefs, sessions };
}

function folderLabel(meta, analysis) {
  const folders = Array.isArray(meta.userSelectedFolders) ? meta.userSelectedFolders : [];
  const source = folders[0] ?? meta.cwd ?? null;
  if (!source) return null;
  // Sessions with no chosen folder run inside the app's internal session dir — not a real project.
  if (source.includes("Application Support/Claude")) {
    return folders.length ? path.basename(source) : null;
  }
  return path.basename(source);
}
