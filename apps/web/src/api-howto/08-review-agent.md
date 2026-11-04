---
title: Review what your agent did
who: Any member
---

1. Find your token's id on the [Tokens](/me/tokens) page, or with `getDeskMe` from the agent itself (`via_token`).
2. List what was done through it: `listAudit` with `newsroom` and `token`.

   ```bash
   curl -s "$ANR_API/desk/newsrooms/ai/audit?token=<token id>" -H "Authorization: Bearer $ANR_TOKEN"
   ```

3. Narrow it with `action` (such as `approve`), `entity` (such as `publications`), `person` or `since`. The platform admin's own acts are in `listPlatformAudit`.

Revoke a token on the Tokens page the moment you no longer trust what holds it.
