import { config } from "./config.js";

/**
 * Board columns are DATA, not code. Each column has:
 *   id     — stable key (also what the Pi board receives)
 *   label  — header text
 *   color  — CSS color for the dashboard accent
 *   rule   — JS expression over `s` (a session's raw signals); first match wins
 *   compact— render slim cards (no activity line) in this column
 *
 * Attention signals available to rules: s.turnOpen, s.blocked, s.blockedOn,
 * s.unseen, s.stalled, s.hasProcess, s.askPending (alias for blockedOn ===
 * "question"), s.agents (array), s.ageSeconds.
 * Descriptive: s.stage, s.project.{name,repo,branch,worktree}, s.pr.{number,
 * state,reviewDecision,isDraft}, s.plan, s.model, s.effort, s.title.
 *
 * Override in config.json with { "columns": [ ... ] } (same shape, rule as a
 * string). A session matching no column lands in the last one. The README
 * documents a stage-based board (Planning/Implementing/In Review/Done) as a
 * drop-in alternative to these attention-based defaults.
 */
/// Seconds a finished-but-unlooked-at session still counts as wanting you.
const UNSEEN_WINDOW = config.needsYouWindowMinutes * 60;

/// Does this session have a live pull request?
const HAS_OPEN_PR = 's.pr && s.pr.state === "OPEN"';

/// A session's directory is a linked git worktree — per-ticket by construction.
const IN_WORKTREE = "s.project && s.project.worktree";
/// It has written to a branch, i.e. it has actually touched code. Per-SESSION,
/// unlike the checkout's current branch, which belongs to the folder.
const TOUCHED_CODE = "s.touchedCode";
const PLANNING = 's.stage === "planning"';

const DEFAULT_COLUMNS = [
  // What KIND of work each session is; the card's leading bar says whether it
  // wants you (see `attentionFor`).
  //
  // "In Progress" used to be everything the ladder couldn't classify — its own
  // positive signal, `writtenBranches`, is unreachable, since anything with a
  // branch already has a PR by the time that rung is tested. So Building is
  // defined by the signals that ARE present: the session sits in a git worktree
  // (per-ticket by construction), or it has actually written to a branch. Those
  // were briefly two columns; splitting them left In Progress permanently empty,
  // because a session that writes code opens a PR shortly after and moves on.
  // What's left is a conversation, which is what Scratch honestly is.
  //
  // Rules stay MUTUALLY EXCLUSIVE, which decouples match precedence from
  // display order: "PR Open" must win over every other column while being drawn
  // last, and Scratch must be a real complement rather than a catch-all.
  {
    id: "scratch",
    label: "Scratch",
    color: "#8b929c",
    // No PR, no worktree, not planning, never wrote code: a conversation.
    rule: `!(${HAS_OPEN_PR}) && !(${IN_WORKTREE}) && !(${PLANNING}) && !(${TOUCHED_CODE})`,
    compact: false,
  },
  {
    id: "planning",
    label: "Planning",
    color: "#c4b5fd",
    rule: `!(${HAS_OPEN_PR}) && !(${IN_WORKTREE}) && ${PLANNING}`,
    compact: false,
  },
  {
    id: "building",
    label: "In Worktree",
    color: "#5eead4",
    // Either signal counts: an isolated worktree, or code actually written.
    rule: `!(${HAS_OPEN_PR}) && (${IN_WORKTREE} || (!(${PLANNING}) && ${TOUCHED_CODE}))`,
    compact: false,
  },
  {
    id: "pr-open",
    label: "PR Open",
    color: "#60a5fa",
    rule: HAS_OPEN_PR,
    compact: false,
  },
];

/// Dot colours by attention state. Their own palette now: with stage-based
/// columns there is no "needs-you" COLUMN to borrow a colour from, and these
/// three greys/greens/ambers are what the board has always used for idle,
/// working and wants-you.
export const ATTENTION_COLORS = {
  "needs-you": "#fbbf24",
  working: "#4ade80",
  idle: "#6b7280",
};

/// Sort order within a column: wants-you first, then running, then quiet.
export const ATTENTION_RANK = { "needs-you": 0, working: 1, idle: 2 };

/**
 * Which attention state a session is in, ignoring its PR — i.e. the column it
 * would sit in if "PR Open" didn't exist. Cards carry this as a dot colour, so
 * a PR-column card still shows at a glance whether it is running, waiting on
 * you, or parked.
 *
 * Returns a column id, so the colour is looked up from the board's own columns
 * rather than duplicated here.
 *
 * The branch ORDER is load-bearing, not incidental:
 *   1. stopped ON you (pending plan/question) — beats a live turn, because
 *      those keep `turnOpen` true while the agent waits on a human;
 *   2. running right now (`turnOpen`);
 *   3. finished and unseen, or a review verdict is waiting;
 *   4. idle.
 */
export function attentionFor(session) {
  // Stopped ON you: a pending AskUserQuestion/ExitPlanMode keeps the turn
  // technically open, so this has to outrank `turnOpen` below.
  if (session.blockedOn === "plan" || session.blockedOn === "question") return "needs-you";
  // Running right now. This must come BEFORE `unseen`: a working agent writes
  // transcript records continuously, so lastActivityAt always outruns the
  // frozen lastFocusedAt and `unseen` is true for the WHOLE turn — which used
  // to swallow every running session into "needs-you" and made green
  // unreachable except on sessions that were effectively dead.
  if (session.turnOpen) return "working";
  // Finished, and you haven't looked since — or a review verdict is waiting.
  // `blocked` covers changes-requested, which is a PR fact rather than an agent
  // stop, so it deliberately does NOT preempt green above.
  if (session.blocked || (session.unseen && session.ageSeconds < UNSEEN_WINDOW)) {
    return "needs-you";
  }
  return "idle";
}

function compile(defs) {
  return defs.map((def) => {
    let test;
    try {
      test = new Function("s", `return !!(${def.rule});`);
    } catch (err) {
      console.error(`[columns] bad rule for "${def.id}" (${err.message}); column matches nothing`);
      test = () => false;
    }
    return { ...def, test };
  });
}

export const columns = compile(
  Array.isArray(config.columns) && config.columns.length ? config.columns : DEFAULT_COLUMNS,
);

/** Public shape (no compiled functions) for API/push consumers. */
export const columnDefs = columns.map(({ id, label, color, compact }) => ({
  id,
  label,
  color,
  compact,
}));

export function columnFor(session) {
  for (const col of columns) {
    try {
      if (col.test(session)) return col.id;
    } catch {
      /* rule threw on this session; try the next column */
    }
  }
  return columns[columns.length - 1].id;
}
