# Drill: a killed worker

A worker dies and stays down (D143). `kill-worker.sh` kills its container; `docker kill` counts as a manual stop, so the restart policy leaves it down, as a worker stuck in a crash or a hang would be, until the drill starts it again. A worker that crashes by itself is restarted by Docker within seconds and shows only on the Outages dashboard.

## Before

- Ask the operator for `anr-prod`. Default to `publisher`, and not across a slot unless that is the point.
- Killing `agents` fires `GaugesStale` instead of `HeartbeatLost`: the agents worker reports every heartbeat's age.

## Run

```bash
infra/drills/kill-worker.sh <project> [--prod] [service] [minutes]   # default publisher, 7
```

Ctrl-C starts the worker at once. If the script itself dies: `docker start <project>-<service>-1`.

## What should happen

| After | Signal |
| --- | --- |
| 3 min | the worker's heartbeat age passes 180 s (Overview, Outages) |
| about 5 min | `HeartbeatLost` for the worker, in the ops chat |
| start | its first beat records the gap as an outage; the alert resolves within 2 minutes |

Jobs for the worker wait in their queue (Queues dashboard) and run when it is back.

## After

Postmortem from `docs/postmortems/template.md`.
