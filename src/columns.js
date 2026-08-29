import { config } from "./config.js";

/**
 * Board columns are DATA, not code. Each column has:
 *   id     — stable key (also what the Pi board receives)
 *   label  — header text
 *   color  — CSS color for the dashboard accent
 *   rule   — JS expression over `s` (a session's raw signals); first match wins
 *   compact— render slim cards (no activity line) in this column
 *
 * Raw signals available to rules: s.turnOpen, s.askPending, s.stalled,
 * s.hasProcess, s.agents (array), s.ageSeconds, s.project, s.model, s.title.
 *
 * Override in config.json with { "columns": [ ... ] } (same shape, rule as a
 * string). A session matching no column lands in the last one.
 */
const DEFAULT_COLUMNS = [
  {
    id: "working",
    label: "Working",
    color: "#4ade80",
    rule: "s.turnOpen",
    compact: false,
  },
  {
    id: "needs-you",
    label: "Needs You",
    color: "#fbbf24",
    rule: `s.askPending || (!s.turnOpen && s.ageSeconds < ${config.needsYouWindowMinutes * 60})`,
    compact: false,
  },
  {
    id: "idle",
    label: "Idle",
    color: "#6b7280",
    rule: "true",
    compact: true,
  },
];

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
