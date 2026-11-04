---
title: Add a source, record its terms, fetch it now
who: Any editor reads and fetches; the Editor-in-Chief changes sources
---

1. See every source's health: `listSourceHealth` with `newsroom`. Failing sources come first; one without read terms is never fetched.
2. See what a source brought in: `listLeads` with `source` (its slug), `since` or `q`.
3. Fetch a source now instead of at its next interval: `fetchSource` with `source` (its id from step 1). A source whose terms nobody has read gets a 409.

   ```bash
   curl -s -X POST "$ANR_API/desk/newsrooms/ai/sources/<source id>/fetch" -H "Authorization: Bearer $ANR_TOKEN"
   ```

4. Look at the agent runs that followed (the summariser writes each new lead's summary): `listAgentRuns` with `role: "summariser"`.

## Change sources (the Editor-in-Chief)

- Add one: `addSource` with `body` as one entry of sources.yaml: `id` (slug), `kind`, `url`, `tier`, `every`, and `publisher`, `use`, `pages`, `vouches` if needed. It is checked by the same rules as the file.
- Record that **you have read its terms yourself**: `setSourceTerms` with `body: { "read": true, "note": "what they allow" }`. Only then is it fetched. An agent must not do this on its own judgement; `read: false` withdraws it.
- Change fields: `updateSource` (null puts one back to its default). Remove: `removeSource`.
- Back them up: `exportSources` returns the newsroom's sources.yaml.
