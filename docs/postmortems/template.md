# Postmortem: <what happened, in a few words>

Copy this file to `docs/postmortems/<YYYY-MM-DD>-<slug>.md`. Blameless: describe what the system and the people in it did and why it made sense at the time, never who is at fault. A chaos drill (D143) gets one too.

- **Date:** <YYYY-MM-DD>
- **Kind:** incident | drill (sleep, killed worker, filled disk)
- **Duration:** <start> to <end>, in the newsroom's timezone and UTC
- **Severity:** readers affected | editors affected | no one affected
- **Author:** <role, e.g. operator>

## Summary

Two or three sentences: what failed, what readers and editors saw, how it ended.

## Impact

- Slots missed or late, by newsroom and series (from the Publishing dashboard).
- Publications held, and why.
- Error budget spent per SLO.
- Data lost, if any (WAL archive age at the start).

## Timeline

| Time (UTC) | What happened | Signal (alert, dashboard, outage row, person) |
| ---------- | ------------- | --------------------------------------------- |
|            |               |                                               |

## Detection

Which alert or check fired first, and how long after the start. What should have fired and did not.

## What went well

## What went badly

## Where we got lucky

## Contributing factors

The conditions that together allowed it; there is rarely a single root cause.

## Actions

Each action is a GitHub issue with an owner. Prefer changes that make the failure impossible or loud over reminders to be careful.

| Action | Kind (prevent, detect, mitigate) | Issue |
| ------ | -------------------------------- | ----- |
|        |                                  |       |
