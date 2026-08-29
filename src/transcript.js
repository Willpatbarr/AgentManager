import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const TAIL_BYTES = 512 * 1024;
// Tool names that represent a spawned agent/workflow rather than a plain tool call.
const AGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);

/** Claude Code flattens a project cwd into a directory name by replacing / and . with -. */
export function flattenCwd(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptPathFor(cwd, cliSessionId) {
  if (cwd) {
    const direct = path.join(config.projectsDir, flattenCwd(cwd), `${cliSessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  // Fallback: search every project dir (cwd may have changed mid-session).
  try {
    for (const dir of fs.readdirSync(config.projectsDir)) {
      const p = path.join(config.projectsDir, dir, `${cliSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
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

  for (const rec of records) {
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
  const askPending = pending.some((b) => b.name === "AskUserQuestion");
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
    turnOpen,
    askPending,
    agents,
    pendingToolCount: pending.length,
    lastActivity,
    aiTitle,
    customTitle,
    lastPrompt: lastPrompt ? String(lastPrompt).slice(0, 140) : null,
  };
}
