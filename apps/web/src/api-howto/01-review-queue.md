---
title: Review and approve the queue
who: Any editor
---

1. List what is held: `getReviewQueue` with `newsroom`.

   ```bash
   curl -s "$ANR_API/desk/newsrooms/ai/queue" -H "Authorization: Bearer $ANR_TOKEN"
   ```

2. Read one publication with its claims, checks and posts: `getDeskPublication` with `newsroom` and `publication`. Note its `version`; an approval covers only the text of that version.
3. See what would be sent: `previewPublication`.
4. Approve it, or send it back to the desk with a note:
   - `approvePublication` with `body: { "version": "<the version you read>" }`
   - `returnPublication` with `body: { "note": "What the desk should change" }`

   ```bash
   curl -s -X POST "$ANR_API/desk/newsrooms/ai/publications/<id>/approve" \
     -H "Authorization: Bearer $ANR_TOKEN" -H "content-type: application/json" \
     -d '{"version":"<version>"}'
   ```

An approval through a token is the token's person's approval, recorded in the audit log with the token. A 409 means the publication changed since you read it: read it again.
