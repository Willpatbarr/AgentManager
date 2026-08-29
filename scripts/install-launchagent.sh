#!/usr/bin/env bash
# Installs (or reinstalls) the AgentManager LaunchAgent. Safe to re-run.
# Override config via env when invoking, e.g.:
#   AM_PI_INGEST_URL=http://pi:8642/ingest/claude-sessions bash scripts/install-launchagent.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.willbarr.agentmanager"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# A LaunchAgent inherits none of your shell's PATH — it gets
# /usr/bin:/bin:/usr/sbin:/sbin — so `gh` (Homebrew, /opt/homebrew/bin) is not
# found and the PR review-state poll fails silently forever, since prs.js keeps
# the last known value on error rather than clearing it. Detected here the same
# way `node` is, so this follows wherever the tools actually live.
GH_DIR="$(dirname "$(command -v gh 2>/dev/null || echo /opt/homebrew/bin/gh)")"
NODE_DIR="$(dirname "$NODE_BIN")"
AGENT_PATH="$NODE_DIR:$GH_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

ENV_KEYS=""
for key in AM_PORT AM_PI_INGEST_URL AM_PI_PUSH_SEC AM_PI_POLL_SEC AM_MAX_AGE_HOURS AM_NEEDS_YOU_MIN AM_STALLED_SEC AM_PROCESS_POLL_SEC AM_PR_POLL_SEC AM_SESSION_STORE AM_PROJECTS_DIR; do
  val="${!key:-}"
  if [ -n "$val" ]; then
    ENV_KEYS="$ENV_KEYS
    <key>$key</key><string>$val</string>"
  fi
done

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>$ENV_KEYS
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agentmanager.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentmanager.err</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded $LABEL — dashboard at http://localhost:${AM_PORT:-8790} (logs: /tmp/agentmanager.log)"
