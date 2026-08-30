import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const TAIL_BYTES = 512 * 1024;
// Tool names that represent a spawned agent/workflow rather than a plain tool call.
const AGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);
/** The same names quoted, for the cheap string pre-filter in `collectAgentRuns`. */
const AGENT_TOOL_NAMES = [...AGENT_TOOLS].map((n) => `"${n}"`);
/**
 * Most agent runs reported per session. A hard cap rather than a time window:
 * the detail panel on the Pi wants the recent history, but this rides a push
 * that fires every few seconds, and a long-running session can spawn agents
 * without limit. Newest-first, so the cap drops the oldest.
 */
const MAX_AGENT_RUNS = 40;
/**
 * Pending tool calls that mean the agent has stopped and is waiting on a human.
 * `ExitPlanMode` matters as much as `AskUserQuestion`: it leaves the turn open,
 * so without it a session awaiting plan approval reads as "Working" — the one
 * state that most needs you is the one that used to hide.
 */
const BLOCKING_TOOLS = new Map([
  ["ExitPlanMode", "plan"],
  ["AskUserQuestion", "question"],
]);

/** Claude Code flattens a project cwd into a directory name by replacing / and . with -. */
export function flattenCwd(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Locate a session's transcript and read its mtime in the same stat that proves
 * it exists. Returns `{ path, mtimeMs }`, or null when there's no transcript.
 *
 * Callers that only need to know *how old* a session is should use this rather
 * than `analyzeTranscript` — the mtime is enough to age-gate a session, and it
 * costs one stat instead of a 512 KB tail read plus a JSON parse per line.
 */
export function resolveTranscript(cwd, cliSessionId) {
  const statOf = (p) => {
    try {
      return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
    } catch {
      return null;
    }
  };

  if (cwd) {
    const direct = statOf(path.join(config.projectsDir, flattenCwd(cwd), `${cliSessionId}.jsonl`));
    if (direct) return direct;
  }
  // Fallback: search every project dir (cwd may have changed mid-session).
  try {
    for (const dir of fs.readdirSync(config.projectsDir)) {
      const found = statOf(path.join(config.projectsDir, dir, `${cliSessionId}.jsonl`));
      if (found) return found;
    }
  } catch {
    /* projects dir missing */
  }
  return null;
}


/**
 * Per-transcript agent-run history, keyed by file path:
 * `{ offset, runs: Map<toolUseId, run> }`.
 *
 * Agent history CANNOT come from the tail. The tail is a fixed 512 KB window,
 * and a `Task` whose `tool_use` record has scrolled out of it is invisible —
 * measured across the real store, most sessions with subagents had **zero** of
 * them left in the window (a 7.4 MB transcript kept none), so the detail panel
 * showed "none this session" for sessions that had plainly run agents.
 *
 * A transcript is append-only, so the fix is a cursor rather than a bigger
 * window: read the whole file once, then only the bytes appended since. The
 * one-time backfill is what makes old runs appear at all; the incremental read
 * is what keeps this affordable inside a scan that fires every 2s.
 */
const agentHistory = new Map();
/** Ceiling on cached transcripts, so a long-lived daemon can't grow unbounded. */
const MAX_HISTORY_FILES = 250;
/** Runs retained per transcript. Above `MAX_AGENT_RUNS` so a late `tool_result` can still close a run that won't be shown. */
const MAX_RUNS_CACHED = 120;

/** The record's own timestamp, or null — see the activity-clock note below. */
function recordTimestamp(rec) {
  if (rec?.timestamp === undefined || rec?.timestamp === null) return null;
  const at = typeof rec.timestamp === "number" ? rec.timestamp : Date.parse(rec.timestamp);
  return Number.isFinite(at) ? at : null;
}

/**
 * Every agent run in the WHOLE transcript, oldest first, reading only the bytes
 * appended since last call.
 *
 * Lines are pre-filtered with plain string tests before `JSON.parse`, because
 * the backfill pass would otherwise parse every record of every transcript on
 * the first scan. Only two kinds of line matter: an agent `tool_use`, and a
 * `tool_result` naming an agent id already seen in this file.
 */
function collectAgentRuns(file, size) {
  let entry = agentHistory.get(file);
  // A file smaller than our cursor was truncated or replaced — start over.
  if (!entry || size < entry.offset) {
    entry = { offset: 0, runs: new Map() };
    if (agentHistory.size >= MAX_HISTORY_FILES) {
      agentHistory.delete(agentHistory.keys().next().value);
    }
    agentHistory.set(file, entry);
  }
  if (size <= entry.offset) return entry.runs;

  const fd = fs.openSync(file, "r");
  let buf;
  try {
    buf = Buffer.alloc(size - entry.offset);
    fs.readSync(fd, buf, 0, buf.length, entry.offset);
  } finally {
    fs.closeSync(fd);
  }

  // Stop at the last complete line and resume there next time, so a record
  // caught mid-write is re-read whole rather than dropped as unparseable.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return entry.runs;
  const text = buf.subarray(0, lastNewline + 1).toString("utf-8");
  entry.offset += lastNewline + 1;

  for (const line of text.split("\n")) {
    if (!line) continue;
    const isUse = line.includes('"tool_use"') && AGENT_TOOL_NAMES.some((n) => line.includes(n));
    // Only worth parsing if it closes a run we already know about.
    const isResult =
      !isUse &&
      line.includes('"tool_result"') &&
      entry.runs.size > 0 &&
      [...entry.runs.keys()].some((id) => line.includes(id));
    if (!isUse && !isResult) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const recordAt = recordTimestamp(rec);

    if (rec.type === "assistant") {
      for (const b of contentBlocks(rec)) {
        if (b.type !== "tool_use" || !AGENT_TOOLS.has(b.name)) continue;
        entry.runs.set(b.id, {
          kind: b.name,
          label: describeToolUse(b),
          agentType: b.input?.subagent_type ?? null,
          model: b.input?.model ?? null,
          startedAt: recordAt,
          endedAt: null,
          failed: false,
        });
      }
    } else if (rec.type === "user") {
      for (const b of contentBlocks(rec)) {
        if (b.type !== "tool_result") continue;
        const run = entry.runs.get(b.tool_use_id);
        if (!run) continue;
        run.endedAt = recordAt;
        run.failed = b.is_error === true;
      }
    }
  }

  // Drop the oldest once over the cap; Map preserves insertion order.
  while (entry.runs.size > MAX_RUNS_CACHED) {
    entry.runs.delete(entry.runs.keys().next().value);
  }
  return entry.runs;
}

function readTailRecords(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  let text;
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift(); // first line is probably clipped
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* clipped/partial line */
    }
  }
  return { records, mtimeMs: stat.mtimeMs, size: stat.size };
}

function contentBlocks(rec) {
  const c = rec?.message?.content;
  return Array.isArray(c) ? c : [];
}

function describeToolUse(block) {
  const input = block.input ?? {};
  switch (block.name) {
    case "Bash":
      return input.description || (input.command ?? "").slice(0, 80) || "shell command";
    case "Read":
    case "Write":
    case "Edit":
      return `${block.name} ${path.basename(String(input.file_path ?? ""))}`.trim();
    case "Task":
    case "Agent":
      return input.description || "subagent";
    case "Workflow":
      return input.name || "workflow";
    case "AskUserQuestion":
      return "waiting on your answer";
    case "ExitPlanMode":
      return "waiting on plan approval";
    default:
      return block.name;
  }
}

function textSnippet(rec, max = 110) {
  for (const b of contentBlocks(rec)) {
    if (b.type === "text" && b.text?.trim()) {
      const t = b.text
        .trim()
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`#>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return t.length > max ? `${t.slice(0, max - 1)}…` : t;
    }
  }
  return null;
}

/**
 * Derive live state from the tail of a session transcript.
 * Returns null if the transcript can't be read.
 */
export function analyzeTranscript(file) {
  let tail;
  try {
    tail = readTailRecords(file);
  } catch {
    return null;
  }
  const { records, mtimeMs, size } = tail;

  const pendingToolUses = new Map(); // tool_use id -> block
  /**
   * Every agent this session ever spawned, oldest first — read from the whole
   * file via a cursor, NOT from the tail. `agents` below derives from what is
   * still pending, so an agent vanishes from it the moment it returns; the
   * detail panel wants the ones that finished just as much as the live ones.
   */
  const agentRuns = collectAgentRuns(file, size);
  let lastAssistantStop = null;
  let lastMeaningful = null; // last user/assistant record
  let aiTitle = null;
  let customTitle = null;
  let lastPrompt = null;
  let lastAssistantText = null;
  let lastToolUse = null;
  let lastRecordAt = 0;

  for (const rec of records) {
    // The real activity clock. Only genuine event records (user/assistant/
    // system/attachment/queue-operation/pr-link) carry a timestamp; the
    // trailing sidecars (last-prompt, ai-title, custom-title, mode) carry none
    // and are rewritten merely by *opening* a session. That's why file mtime
    // can't be trusted for activity, and why this max is taken over whatever
    // records actually stamped themselves.
    const recordAt = recordTimestamp(rec);
    if (recordAt !== null && recordAt > lastRecordAt) lastRecordAt = recordAt;

    switch (rec.type) {
      case "ai-title":
        aiTitle = rec.aiTitle ?? aiTitle;
        break;
      case "custom-title":
        customTitle = rec.customTitle ?? customTitle;
        break;
      case "last-prompt":
        lastPrompt = rec.lastPrompt ?? lastPrompt;
        break;
      case "assistant": {
        lastMeaningful = rec;
        if (rec.message?.stop_reason) lastAssistantStop = rec.message.stop_reason;
        const snippet = textSnippet(rec);
        if (snippet) lastAssistantText = snippet;
        for (const b of contentBlocks(rec)) {
          if (b.type === "tool_use") {
            pendingToolUses.set(b.id, b);
            lastToolUse = b;
          }
        }
        break;
      }
      case "user": {
        lastMeaningful = rec;
        for (const b of contentBlocks(rec)) {
          if (b.type !== "tool_result") continue;
          // Agent runs are closed by `collectAgentRuns`, which sees the whole
          // file; this loop only tracks what is still in flight.
          pendingToolUses.delete(b.tool_use_id);
        }
        break;
      }
      default:
        break;
    }
  }

  const pending = [...pendingToolUses.values()];
  // What the agent is stopped on, if anything. "plan" outranks "question" so a
  // session with both pending reports the heavier gate.
  let blockedOn = null;
  for (const b of pending) {
    const reason = BLOCKING_TOOLS.get(b.name);
    if (!reason) continue;
    if (reason === "plan" || blockedOn === null) blockedOn = reason;
  }
  const agents = pending
    .filter((b) => AGENT_TOOLS.has(b.name))
    .map((b) => ({ kind: b.name, label: describeToolUse(b) }));

  // Turn is open unless the last assistant message explicitly ended it and
  // nothing meaningful (a new user prompt) came after with the turn still open.
  let turnOpen;
  if (!lastMeaningful) {
    turnOpen = false;
  } else if (lastMeaningful.type === "user") {
    // Either a fresh prompt (turn starting) or a tool_result (turn mid-flight).
    turnOpen = true;
  } else {
    turnOpen = !["end_turn", "stop_sequence", "refusal"].includes(lastAssistantStop ?? "");
  }

  let lastActivity = null;
  if (lastToolUse && turnOpen) lastActivity = describeToolUse(lastToolUse);
  else if (lastAssistantText) lastActivity = lastAssistantText;
  else if (lastPrompt) lastActivity = `prompt: ${String(lastPrompt).slice(0, 90)}`;

  return {
    mtimeMs,
    lastRecordAt,
    turnOpen,
    blockedOn,
    agents,
    // Newest first, so `MAX_AGENT_RUNS` drops the oldest rather than the ones
    // you'd actually want to look at. Unlike `agents`, these include runs that
    // have already finished.
    agentRuns: [...agentRuns.values()].reverse().slice(0, MAX_AGENT_RUNS),
    pendingToolCount: pending.length,
    lastActivity,
    aiTitle,
    customTitle,
    lastPrompt: lastPrompt ? String(lastPrompt).slice(0, 140) : null,
  };
}
