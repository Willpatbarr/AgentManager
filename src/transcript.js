import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const TAIL_BYTES = 512 * 1024;
// Tool names that represent a spawned agent/workflow rather than a plain tool call.
const AGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);
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
  return { records, mtimeMs: stat.mtimeMs };
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
  const { records, mtimeMs } = tail;

  const pendingToolUses = new Map(); // tool_use id -> block
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
    if (rec.timestamp !== undefined && rec.timestamp !== null) {
      const at = typeof rec.timestamp === "number" ? rec.timestamp : Date.parse(rec.timestamp);
      if (Number.isFinite(at) && at > lastRecordAt) lastRecordAt = at;
    }

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
          if (b.type === "tool_result") pendingToolUses.delete(b.tool_use_id);
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
    pendingToolCount: pending.length,
    lastActivity,
    aiTitle,
    customTitle,
    lastPrompt: lastPrompt ? String(lastPrompt).slice(0, 140) : null,
  };
}
