---
title: Pause publishing, retry or cancel work
who: The platform admin
---

1. See the state: `getOps`. It shows pauses, queues, failed and waiting jobs, backups, workers and outages.
2. Pause publishing in one newsroom with `pauseOps` and `body: { "newsroom": "ai" }`, or everywhere with `body: {}`. `resumeOps` takes the same body.
3. Retry a failed job or cancel one that has not started: `retryOpsJob` or `cancelOpsJob` with `body: { "queue", "id" }`.
4. Drain a queue: `drainOpsQueue` with `body: { "queue", "drained": true }`.
5. Ask the host for a backup check: `requestBackupCheck`.

None of these approves, publishes or deletes anything.
