# AgentManager

Live dashboard + API for the Claude Code sessions running on this Mac, with
**click-to-focus** (both from the Mac dashboard and from the DeskDashboard Pi board).

Zero dependencies — plain Node 18+.

```bash
node src/index.js        # dashboard at http://localhost:8790
```

## What it reads

| Data | Source |
|------|--------|
| Session identity, title, model, archived flag | `~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_*.json` — the desktop app's live session index. `cliSessionId` in each file is the transcript filename. |
| Stage, PR, branch, plan, worktree | The same `local_*.json`: `permissionMode`, `prs[]`, `writtenBranches`, `planPath`, `branch`, `originCwd`, `worktreePath`, `lastFocusedAt`. See [src/stage.js](src/stage.js). |
| Live state, last activity, subagents | Tail of `~/.claude/projects/<flattened-cwd>/<cliSessionId>.jsonl`. A pending `AskUserQuestion` or `ExitPlanMode` ⇒ **blocked** ⇒ needs-you; an open unblocked turn ⇒ **working** (with a `stalled` flag when the transcript goes quiet mid-turn); everything else ⇒ **idle**. Pending `Task`/`Agent`/`Workflow` calls become agent chips. |
| Activity clock | The max `timestamp` across transcript records — **never file mtime**. Only real event records carry timestamps; the trailing `last-prompt`/`ai-title`/`custom-title` sidecars carry none and are rewritten merely by *opening* a session, so mtime tracks when you last looked at it, not when it last ran. (mtime is still used as a cheap upper bound to skip reading old transcripts.) |
| PR review state | `gh pr list --repo <r> --author @me --state open` — the one fact GitHub has and the local metadata doesn't. Lazy: no session with an OPEN PR means no process is spawned. Refreshed out-of-band on `AM_PR_POLL_SEC`, never inside the scan. See [src/prs.js](src/prs.js). |
| Process liveness | `ps` — desktop session processes carry `--resume=<cliSessionId>` after their first resume. Informational (`hasProcess`); state is derived from the transcript. |

## Click-to-focus

`POST /api/focus/<local_id>` (and the Pi's tap queue, which calls the same code)
activates Claude.app and then picks one of three behaviours depending on what is
torn off — see [What focus actually does](#what-focus-actually-does).

The short version: **a tap on a session you have torn off raises that window
instead of stealing it back.** A tap on anything else still switches the main
window, which still closes torn-off windows — that is the deep link's doing and
no URL avoids it. Protecting them costs switching, so it ships off.

### Why taps close torn-off windows

`claudeURLHandler` switches on the URL's **host**, not its pathname, so
`/claude-code-desktop/<id>` and `/epitaxy/<id>` are not special-cased against
each other — both reach one session handler ending in the app's `navigateTo`:

```js
const d = dispatchers.get(win.webContents);
if (d && !coldStart) { d.dispatchNavigate(route); return; }  // in-place, no page load
win.webContents.loadURL(...)                                 // full reload
```

The in-place branch depends on a per-`webContents` dispatcher created lazily
*inside* the app. **No URL can conjure it**, and in practice the session route
lands on `loadURL` — confirmed by `Loaded https://claude.ai (web commit …)`
appearing in `~/Library/Logs/Claude/main.log` on every focus, alongside MCP
servers being torn down and relaunched. That reload reboots the renderer every
popout is registered against (`WindowManager.RegisterWindow`), so they all die.

So there is no deep link that focuses a session without costing you popouts —
the only lever is whether to send one at all, which is what case 1 (always) and
case 2 (opt-in) below trade against.

### What focus actually does

1. **Target is torn off** → `AXRaise` that window, no deep link. The session
   comes forward in the window you put it in, and nothing is reclaimed.
2. **Something else is torn off** → deep link as normal, which closes those
   windows. Set `AM_PROTECT_POPOUTS=1` to skip the link and keep them instead;
   off by default because the only way to protect them is to stop switching
   sessions, and losing click-to-focus is the worse trade.
3. **Nothing torn off** → deep link as normal.

Window titles are the only handle the app offers: popouts are named for their
session, the main window is plain `Claude`, and the accessibility tree exposes
no web content at all (the whole window is one unnamed `AXGroup`). Two sessions
with identical titles are indistinguishable, and a session renamed after
tear-off stops matching; both fall through to the rules above rather than
misfiring.

**This needs Accessibility permission**, and the daemon runs under launchd — a
*different* TCC subject from your shell, so testing `osascript` in a terminal
proves nothing about it. Grant it to the LaunchAgent's node binary
(`/opt/homebrew/bin/node`) in System Settings > Privacy & Security >
Accessibility. Without it the daemon cannot see windows at all, every tap looks
like case 3, and popouts die — so the failure is logged loudly to
`/tmp/agentmanager.err` rather than swallowed. A Homebrew `node` upgrade can
stale the grant; that log line is how you'll know.

Creating a popout from outside is not reachable, so "make Open tear off a new
window" isn't available: `RegisterWindow` is origin-gated to the claude.ai top
frame and takes only geometry/chrome props — no URL, no session id — and there
is no new-window menu item or deep-link case that makes one.

### The deep link, for sessions that aren't torn off

| | URL | What the app does |
|---|---|---|
| **hard** (default) | `claude://claude.ai/claude-code-desktop/<id>` | Reaches the session. **Works.** |
| **soft** (off) | `claude://claude.ai/epitaxy/<id>` | Routed but inert on 1.24012.9 — accepted, logs no `unrecognized code path` warning (a bare `/local_<id>` does), yet the window never changes session and the target's `lastFocusedAt` never updates. |

Soft is worse than useless — a silent no-op — so `hard` is the default, and
anything that isn't exactly `"soft"` is coerced to `hard` so a typo can't turn
focus off.

`AM_FOCUS_LINK=soft` (env, or `focusLink` in `config.json`) flips it, and the
soft URL is only ever used when Claude.app is **already running** — a cold start
always takes the hard link, since the dispatcher would be firing into a renderer
that doesn't exist yet, and a just-launched app has no popouts to protect.
Re-test that knob after a Claude update; the routing is version-coupled:

```bash
AM_FOCUS_LINK=soft bash scripts/install-launchagent.sh
```

Also ruled out, so nobody re-litigates it:
`claude://resume?session=<cliSessionId>` exists but **imports a duplicate** of
desktop-native sessions. Don't use it for focusing.

## API

- `GET /api/sessions` — the snapshot the dashboard renders
- `POST /api/focus/local_<uuid>` — raise Claude.app on that session
- `GET /api/health`

## Malleable columns

Board columns are **data, not code**. The defaults (Working / Needs You / Idle)
live in [src/columns.js](src/columns.js); override them with a `columns` array
in `config.json` — order matters, first matching rule wins, non-matches land in
the last column:

```json
{
  "columns": [
    { "id": "blocked",  "label": "Blocked",  "color": "#f87171", "rule": "s.blocked || s.stalled" },
    { "id": "cooking",  "label": "Cooking",  "color": "#4ade80", "rule": "s.turnOpen" },
    { "id": "review",   "label": "Review",   "color": "#fbbf24", "rule": "s.unseen && s.ageSeconds < 7200" },
    { "id": "parked",   "label": "Parked",   "color": "#6b7280", "rule": "true", "compact": true }
  ]
}
```

Rules are JS expressions over a session `s`. **Attention** signals are flat:
`turnOpen`, `blocked`, `blockedOn` (`"question"` | `"plan"` |
`"changes-requested"` | `null`), `unseen`, `stalled`, `hasProcess`,
`askPending` (alias for `blockedOn === "question"`), `agents` (array),
`ageSeconds`. **Descriptive** facets are grouped: `stage`, `project`
(`.name`/`.path`/`.repo`/`.branch`/`.base`/`.worktree`), `pr`
(`.number`/`.url`/`.repo`/`.state`/`.reviewDecision`/`.isDraft`, or `null`),
`plan`, `model`, `effort`, `permissionMode`, `title`.

The web dashboard AND the Pi push both follow the config — reshaping the board
never touches the Swift side.

Under the LaunchAgent the daemon **restarts itself** when anything under `src/`
changes: it exits, and `KeepAlive=true` brings it straight back on the new code.
launchd throttles the respawn to ~10s, so give it a few seconds before deciding
an edit didn't take — that delay is the throttle, not a fault. The watcher is
armed by `AM_RELOAD_ON_CHANGE=1` (set by `scripts/install-launchagent.sh`), so a
hand-run `node src/index.js` doesn't quit on save with nothing to restart it —
restart that one yourself.

This matters more than it looks. Node caches ES modules for the life of the
process, so an edited file simply never takes effect until a restart — and
because the Pi degrades gracefully when a field goes missing, a stale daemon is
*invisible*. One did run a day behind, omitted the whole `agents` field, and
presented as a Pi rendering bug. Hence both the auto-reload and the wire-version
badge below.

### Wire version

The push body carries `wireVersion` (`WIRE_VERSION` in [src/push.js](src/push.js)).
The Pi keeps its own copy (`ClaudeSessionsReading.currentWireVersion`) and shows
an **OLD MAC** badge on the board when the number it receives is lower — or
absent, which means a producer old enough to predate the field.

Bump `WIRE_VERSION` whenever you add a field to the push body, and bump the Pi's
constant when the Pi learns to read it. The two constants live in two repos and
cannot be shared: them being able to disagree *is* the signal. It's a
hand-bumped integer rather than a git SHA for the same reason — a SHA would
false-alarm on every commit that never touched the wire.

### Stage columns instead of attention columns

The defaults answer *"do I need to walk over there?"*, which is what the Pi
board is for. To slice by lifecycle instead, drop this in `config.json`:

```json
{
  "columns": [
    { "id": "planning",     "label": "Planning",     "color": "#a78bfa", "rule": "s.stage === 'planning'" },
    { "id": "implementing", "label": "Implementing", "color": "#4ade80", "rule": "s.stage === 'implementing'" },
    { "id": "review",       "label": "In Review",    "color": "#fbbf24", "rule": "s.stage === 'review'" },
    { "id": "done",         "label": "Done",         "color": "#6b7280", "rule": "true", "compact": true }
  ]
}
```

`stage` is derived in [src/stage.js](src/stage.js), first match wins:
`permissionMode === "plan"` → planning; any OPEN PR → review; PRs but all
merged/closed → done; `writtenBranches` → implementing; `planPath` → planning;
else implementing. The live `permissionMode` leads deliberately, so a stale
`planPath` from an already-implemented plan can't outrank what the session is
doing right now.

## Config

Env vars (or a `config.json` next to `package.json` with the same keys):

| Env | Default | Meaning |
|-----|---------|---------|
| `AM_PORT` | `8790` | HTTP port |
| `AM_SESSION_STORE` | app's dir | Claude desktop's session index directory |
| `AM_PROJECTS_DIR` | `~/.claude/projects` | Transcript root |
| `AM_MAX_AGE_HOURS` | `48` | Drop sessions older than this |
| `AM_NEEDS_YOU_MIN` | `120` | Unseen-but-unblocked sessions older than this become idle |
| `AM_STALLED_SEC` | `120` | Mid-turn quiet time before the `stalled` flag |
| `AM_PROCESS_POLL_SEC` | `15` | How often to re-run `ps` for `hasProcess` liveness |
| `AM_PR_POLL_SEC` | `600` | How often to ask GitHub for PR review state |
| `AM_PI_INGEST_URL` | unset | e.g. `http://pi:8642/ingest/claude-sessions` — enables the DeskDashboard push loop |
| `AM_PI_PUSH_SEC` | `5` | Push interval |

## Run at login

```bash
bash scripts/install-launchagent.sh
```

Re-run after changing config; it rewrites and reloads the plist. Logs land in
`/tmp/agentmanager.log`.
