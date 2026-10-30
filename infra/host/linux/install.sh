#!/usr/bin/env bash
# The linux host profile (D127): systemd user units for the deploying user, kept running without a
# login. Run once on the server as that user (in the docker group), with the repo at /opt/anr:
#   infra/host/linux/install.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(cd ../../.. && pwd)" == /opt/anr ]] || { echo "the repo must be at /opt/anr (D127)" >&2; exit 1; }
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
cp ./*.service ./*.timer "$units/"
systemctl --user daemon-reload
for timer in ./*.timer; do systemctl --user enable --now "$(basename "$timer")"; done
# User units run only while the user is logged in, unless lingering.
loginctl enable-linger "$USER"
systemctl --user list-timers 'anr-*'
