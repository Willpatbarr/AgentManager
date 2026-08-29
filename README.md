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

`POST /api/focus/<local_id>` runs:

```
osascript -e 'tell application "Claude" to activate'
open "claude://claude.ai/claude-code-desktop/<local_id>"
```

The desktop app redirects that URL to the session's real route (`/epitaxy/<id>`).
Found by reading the app bundle's `claudeURLHandler`; verified on 1.24012.9.
It re-renders the app rather than smoothly switching — known cosmetic tradeoff.
`claude://resume?session=<cliSessionId>` also exists but **imports a duplicate**
of desktop-native sessions, so don't use it for focusing.

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
never touches the Swift side. Restart the daemon after editing.

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
