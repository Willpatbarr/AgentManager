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

const DEFAULT_COLUMNS = [
  // ORDER IS DISPLAY ORDER — and, because `columnFor` takes the first match, it
  // would also be match precedence. Those two wants disagree here: the board
  // reads left-to-right coldest-to-hottest, but "PR Open" has to WIN over the
  // other three (an open PR belongs in the PR column whatever else is true of
  // it) while still being drawn last. So every rule is written MUTUALLY
  // EXCLUSIVE — each of the first three excludes an open PR — which decouples
  // precedence from position and makes the array safe to reorder for looks.
  //
  // A card in the PR column still shows its underlying state through its dot
  // colour (see `attentionFor`), so nothing is lost by moving it out of the
  // column that colour names.
  {
    id: "idle",
    label: "Idle",
    color: "#6b7280",
    rule: `!s.turnOpen && !s.blocked && !(s.unseen && s.ageSeconds < ${UNSEEN_WINDOW}) && !(${HAS_OPEN_PR})`,
    compact: true,
  },
  {
    id: "working",
    label: "Working",
    color: "#4ade80",
    // Must exclude blocked: an ExitPlanMode session leaves the turn open, so
    // without this it would read as Working while it waits on you.
    rule: `s.turnOpen && !s.blocked && !(${HAS_OPEN_PR})`,
    compact: false,
  },
  {
    id: "needs-you",
    label: "Needs You",
    color: "#fbbf24",
    // Blocked means genuinely stopped on a human: a pending question, a plan
    // awaiting approval, or a PR with changes requested.
    rule: `(s.blocked || (s.unseen && s.ageSeconds < ${UNSEEN_WINDOW})) && !(${HAS_OPEN_PR})`,
    compact: false,
  },
  {
    id: "pr-open",
    label: "PR Open",
    color: "#60a5fa",
    // EVERY open PR, including one with changes requested — the card's dot
    // says whether it needs you.
    rule: HAS_OPEN_PR,
    compact: false,
  },
];

/**
 * Which attention state a session is in, ignoring its PR — i.e. the column it
 * would sit in if "PR Open" didn't exist. Cards carry this as a dot colour, so
 * a PR-column card still shows at a glance whether it is running, waiting on
 * you, or parked.
 *
 * Returns a column id, so the colour is looked up from the board's own columns
 * rather than duplicated here.
 */
export function attentionFor(session) {
  if (session.blocked || (session.unseen && session.ageSeconds < UNSEEN_WINDOW)) {
    return "needs-you";
  }
  if (session.turnOpen) return "working";
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
