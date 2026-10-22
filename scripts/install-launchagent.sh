#!/bin/sh
# Install a LaunchAgent that runs `pnpm start` in this repo at login and keeps it alive (§15).
# Usage: scripts/install-launchagent.sh        (install / update)
#        scripts/install-launchagent.sh remove (uninstall)
set -eu
LABEL=com.ensemble.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.ensemble/logs"

if [ "${1:-}" = "remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $PLIST"
  exit 0
fi

PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then echo "pnpm not found on PATH" >&2; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# launchd starts with a minimal PATH; bake in the current one so node, pnpm, git and the AI CLIs resolve.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array><string>$PNPM</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST — Ensemble starts at login. Logs: $LOG_DIR/server.log"
