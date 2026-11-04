---
title: Check sources and fetch one now
who: Any editor
---

1. See every source's health: `listSourceHealth` with `newsroom`. Failing sources come first; one without read terms is never fetched.
2. See what a source brought in: `listLeads` with `source` (its slug), `since` or `q`.
3. Fetch a source now instead of at its next interval: `fetchSource` with `source` (its id from step 1). A source whose terms nobody has read gets a 409.

   ```bash
   curl -s -X POST "$ANR_API/desk/newsrooms/ai/sources/<source id>/fetch" -H "Authorization: Bearer $ANR_TOKEN"
   ```

4. Look at the agent runs that followed (the summariser writes each new lead's summary): `listAgentRuns` with `role: "summariser"`.
