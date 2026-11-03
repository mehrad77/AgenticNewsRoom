# Drill: host outage

Rehearses the host going down (D143): `pause.sh` pauses every running container of the project except `lgtm` and `otel-collector`, so Grafana sees the outage from inside. The real drill (milestone 7b's operator task) sleeps or stops the host instead; then nothing on the host can alert, and only UptimeRobot does.

## Before

- Ask the operator; on `anr-prod` it spends error budget on purpose. Pick the length to cross a slot if the drill should show `SlotMissed` (the Publishing dashboard lists the next slots).
- Note the WAL archive age (Backups and disk): it bounds the data a real outage could lose.

## Run

```bash
infra/drills/pause.sh <project> [--prod] [minutes]   # default 15
```

Ctrl-C unpauses at once. If the script itself dies, unpause by hand: `docker unpause $(docker ps -q --filter label=com.docker.compose.project=<project> --filter status=paused)`.

## What should happen

| After | Signal |
| --- | --- |
| 5 min | UptimeRobot: `/healthz` through the tunnel fails (prod only) |
| about 7 min | `TunnelDown`: cloudflared's scrape is gone |
| about 10 min | `GaugesStale`: the agents worker reports nothing |
| unpause | each worker's first beat records the gap as an outage (Outages dashboard); `SlotMissed` if a slot passed |

The alerts resolve within a few minutes of the unpause.

## After

Write the postmortem from `docs/postmortems/template.md`, with the times the script printed.
