---
title: Run the check of imported news
who: The Editor-in-Chief
---

1. See where the check stands: `getRecheck` with `newsroom`. It counts imported items checked, waiting and failed, and shows the current or last run.
2. Make sure the local models it uses are loaded (the platform admin's `getLocalModels` and `loadLocalModel`); a run that finds one missing ends as blocked before it spends any item's try.
3. Start it: `startRecheck` with `newsroom`. The agents worker works it a few stories at a time until nothing is left.

   ```bash
   curl -s -X POST "$ANR_API/desk/newsrooms/ai/recheck/start" -H "Authorization: Bearer $ANR_TOKEN"
   ```

4. Stop it whenever you like: `stopRecheck`. The round in progress finishes first.

A 409 on start means a run is already open.
