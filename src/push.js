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
/**
 * How long an agent run has been going, or how long it took. Null when the
 * transcript record carried no timestamp to measure from — the Pi renders the
 * agent without a duration rather than showing a made-up one.
 */
function agentSeconds(run) {
  if (!run.startedAt) return null;
  const end = run.endedAt ?? Date.now();
  return Math.max(0, Math.round((end - run.startedAt) / 1000));
}

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
        // Deliberately flattened to the name string. `s.project` is an object
        // now, but the Pi's Swift decoder declares `project: String?` — handing
        // it the facet would fail the decode for the WHOLE payload and blank
        // the board. Stays flat until the Pi side lands.
        project: s.project?.name ?? null,
        model: s.model,
        state: s.state,
        attention: s.attention,
        // Resolved on the session (scanner) so the API, the web board and the
        // Pi all read one field — a stage-based board has no attention COLUMN
        // for a client to look a colour up from.
        attentionColor: s.attentionColor,
        stage: s.stage,
        stalled: s.stalled,
        // Retained alias; the Swift decoder reads this one today.
        askPending: s.askPending,
        blockedOn: s.blockedOn,
        branch: s.project?.branch ?? null,
        prNumber: s.pr?.number ?? null,
        prState: s.pr?.state ?? null,
        prReviewDecision: s.pr?.reviewDecision ?? null,
        // Still "how many are in flight", which is what the card's ⚙n means and
        // what the web board's chips count. The list below is a different
        // question and deliberately a different field.
        agentCount: s.agents.length,
        lastActivity: s.lastActivity,
        ageSeconds: s.ageSeconds,

        // --- Session detail panel (long-press on the Pi) ---
        // Flattened per the rule above: scalars only, never the facet objects.
        repo: s.project?.repo ?? null,
        base: s.project?.base ?? null,
        worktree: s.project?.worktree ?? false,
        prIsDraft: s.pr?.isDraft ?? false,
        effort: s.effort ?? null,
        permissionMode: s.permissionMode ?? null,
        planName: s.plan?.name ?? null,
        // `running` and `seconds` are computed HERE, from the Mac's own clock,
        // so the Pi gets numbers rather than timestamps it would have to
        // reconcile against a clock that may not agree with this one.
        agents: (s.agentRuns ?? []).map((a) => ({
          label: a.label,
          agentType: a.agentType,
          model: a.model,
          running: a.endedAt === null,
          seconds: agentSeconds(a),
          failed: a.failed === true,
        })),
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
