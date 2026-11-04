---
title: Add, change or remove a member
who: The Editor-in-Chief
---

1. List the people: `listMembers` with `newsroom`.
2. Add one by email: `addMember` with `body: { "email": "…", "role": "editor" }`. They sign in through Cloudflare Access with that email, so the Access policy must let it in as well.

   ```bash
   curl -s -X POST "$ANR_API/desk/newsrooms/ai/members" \
     -H "Authorization: Bearer $ANR_TOKEN" -H "content-type: application/json" \
     -d '{"email":"someone@example.com","role":"editor"}'
   ```

3. Change a role: `setMemberRole` with `member` (their `user_id`) and `body: { "role": "editor-in-chief" }`.
4. Remove someone: `removeMember` with `member`.

A newsroom always keeps one Editor-in-Chief: a change that would leave none gets a 409. Every change is in the audit log.
