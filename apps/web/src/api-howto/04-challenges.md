---
title: Answer a reader's challenge
who: Any editor; the newsroom's corrections owner owns the answer
---

1. List challenges: `listChallenges` with `newsroom`; read one with `getChallenge`.
2. Acknowledge it within 24 hours: `acknowledgeChallenge` with `body: { "note": "…" }` (optional). The reader sees the note.
3. Answer it within 48 hours:
   - `rejectChallenge` with `body: { "answer": "Why the piece stands" }`, or
   - `upholdChallenge` with `body: { "answer", "claim", "lesson", "notices" }`: the claim that was wrong (its ref, such as `c3`), what the gate should have caught, and the correction notice per language. It publishes the corrections.
4. Record the lesson's GitHub issue: `fileChallengeIssue` with `body: { "url": "…" }`.
