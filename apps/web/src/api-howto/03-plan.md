---
title: Choose the cycle's theme and the weekly picks
who: The Editor-in-Chief
---

1. Read the plan: `getPlan` with `newsroom`. It lists the planner's proposed themes for the cycle and the three candidates for each weekly series.
2. Approve a theme, edited as you want it: `approveTheme` with `cycle` and `body: { "theme", "angle", "calendar" }`. The calendar has the same weeks as proposed, each with its focus.
3. Choose a weekly pick: `choosePick` with `pick` and `body: { "candidate": 0 }` (0, 1 or 2).

These are editorial decisions. An agent should make them only when the person asked it to.
