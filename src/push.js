import { config } from "./config.js";
import { focusSession } from "./focus.js";

/**
 * Producer loop: pushes the latest snapshot to the DeskDashboard ingest
 * endpoint on the Pi (same pattern as DeskDashboard's now-playing producer),
 * and polls the Pi's focus-tap queue. Taps flow Pi->Mac through that queue
 * because this Mac's firewall drops incoming connections — the Mac can always
 * reach the Pi, so both directions ride Mac-initiated requests.
 * No-op unless AM_PI_INGEST_URL / config.piIngestUrl is set.
 */
export function startPiPush(getSnapshot) {
  if (!config.piIngestUrl) return null;

  const push = async () => {
    const snap = getSnapshot();
    if (!snap) return;
    const body = {
      updatedAt: snap.updatedAt,
      columns: snap.columns?.map(({ id, label, color, compact }) => ({ id, label, color, compact })),
      sessions: snap.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        model: s.model,
        state: s.state,
        stalled: s.stalled,
        askPending: s.askPending,
        agentCount: s.agents.length,
        agents: s.agents.map((a) => a.label).slice(0, 3),
        lastActivity: s.lastActivity,
        ageSeconds: s.ageSeconds,
      })),
    };
    try {
      await fetch(config.piIngestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
    } catch (err) {
      // Pi being offline is normal; stay quiet unless verbose.
      if (process.env.AM_VERBOSE) console.error(`[push] ${err.message}`);
    }
  };

  const queueUrl = new URL("/claude-focus-queue", config.piIngestUrl).toString();
  const pollQueue = async () => {
    try {
      const res = await fetch(queueUrl, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const { focus } = await res.json();
      for (const id of focus ?? []) {
        console.log(`[push] Pi tap -> focusing ${id}`);
        focusSession(id).catch((err) => console.error(`[push] focus ${id} failed: ${err.message}`));
      }
    } catch (err) {
      if (process.env.AM_VERBOSE) console.error(`[push] queue poll: ${err.message}`);
    }
  };

  const timer = setInterval(push, config.piPushIntervalSeconds * 1000);
  const queueTimer = setInterval(pollQueue, config.piFocusPollSeconds * 1000);
  push();
  console.log(
    `[push] pushing to ${config.piIngestUrl} every ${config.piPushIntervalSeconds}s; ` +
      `polling focus taps every ${config.piFocusPollSeconds}s`,
  );
  return { timer, queueTimer };
}
