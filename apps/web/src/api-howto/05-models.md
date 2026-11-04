---
title: Load local models and switch model chains
who: The platform admin
---

1. See the catalog and the chains in force: `getAdminModels`.
2. See what LM Studio has and has loaded: `getLocalModels`.
3. Load one: `loadLocalModel` with `body: { "model": "<key>", "context_length": 65536 }`. Unload with `unloadLocalModel` and its `instance_id`.

   ```bash
   curl -s -X POST "$ANR_API/desk/admin/models/local/load" \
     -H "Authorization: Bearer $ANR_TOKEN" -H "content-type: application/json" \
     -d '{"model":"google/gemma-4-12b"}'
   ```

4. Set a role's chain from the catalog's models: `setModelRoles` with the whole `roles` object, as `getAdminModels` returns it. `resetModelRoles` goes back to the models file's chains.
