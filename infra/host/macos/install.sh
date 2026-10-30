#!/usr/bin/env bash
# The macOS host profile (D127): launchd agents for the logged-in operator. Run once, and again
# after moving the repo: infra/host/macos/install.sh
# Also, once: sudo pmset -c sleep 0 disksleep 0, and Docker Desktop set to start at login. After
# a reboot nothing runs until the operator logs in.
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd ../../.. && pwd)"
agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents" "$HOME/Library/Logs/anr"
for plist in ./anr.*.plist; do
  label="$(basename "$plist" .plist)"
  sed -e "s|__ANR_DIR__|$repo|g" -e "s|__HOME__|$HOME|g" "$plist" >"$agents/$label.plist"
  plutil -lint -s "$agents/$label.plist"
  # Reload: bootout fails harmlessly when the agent is not loaded yet.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist"
done
launchctl list | grep -E '\banr\.' || true
