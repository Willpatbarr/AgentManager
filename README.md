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
| Live state, last activity, subagents | Tail of `~/.claude/projects/<flattened-cwd>/<cliSessionId>.jsonl`. A pending `AskUserQuestion` or a closed turn ⇒ **needs-you**; an open turn ⇒ **working** (with a `stalled` flag when the transcript has gone quiet mid-turn); everything else ⇒ **idle**. Pending `Task`/`Agent`/`Workflow` tool calls become agent chips. |
| Process liveness | `ps` — desktop session processes carry `--resume=<cliSessionId>` after their first resume. Informational only (`hasProcess`); state is derived from the transcript. |

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
    { "id": "blocked",  "label": "Blocked",  "color": "#f87171", "rule": "s.askPending || s.stalled" },
    { "id": "cooking",  "label": "Cooking",  "color": "#4ade80", "rule": "s.turnOpen" },
    { "id": "review",   "label": "Review",   "color": "#fbbf24", "rule": "!s.turnOpen && s.ageSeconds < 7200" },
    { "id": "parked",   "label": "Parked",   "color": "#6b7280", "rule": "true", "compact": true }
  ]
}
```

Rules are JS expressions over a session `s` with: `turnOpen`, `askPending`,
`stalled`, `hasProcess`, `agents` (array), `ageSeconds`, `project`, `model`,
`title`. The web dashboard AND the Pi push both follow the config — reshaping
the board never touches the Swift side. Restart the daemon after editing.

## Config

Env vars (or a `config.json` next to `package.json` with the same keys):

| Env | Default | Meaning |
|-----|---------|---------|
| `AM_PORT` | `8790` | HTTP port |
| `AM_MAX_AGE_HOURS` | `48` | Drop sessions older than this |
| `AM_NEEDS_YOU_MIN` | `60` | Closed-turn sessions older than this become idle |
| `AM_STALLED_SEC` | `120` | Mid-turn quiet time before the `stalled` flag |
| `AM_PI_INGEST_URL` | unset | e.g. `http://pi:8642/ingest/claude-sessions` — enables the DeskDashboard push loop |
| `AM_PI_PUSH_SEC` | `5` | Push interval |

## Run at login

```bash
bash scripts/install-launchagent.sh
```

Re-run after changing config; it rewrites and reloads the plist. Logs land in
`/tmp/agentmanager.log`.
