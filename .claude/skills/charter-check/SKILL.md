---
name: charter-check
description: Review a change, diff or feature request against the ANR charter's invariants and boundaries. Use before merging changes to agents, publishing, tenancy, disclosure or the verifier, and whenever a feature request might cross a "What ANR is not" line.
---

# Charter check

Review the change (default: `git diff` against `main`) and report each finding with file and line.

## 1. Invariants (`AGENTS.md#invariants`)

For each, say "holds" or show where it breaks:
1. Only code publishes; agents write only through `submit`.
2. Agents have exactly four tools; no web access.
3. Every factual claim cites a stored lead and a passage from its frozen text.
4. The fact-checker's model differs from the writer's.
5. The gate can hold, never approve; failed, partial, errored or timed-out checks go to a person.
6. Every new tenant table has `newsroom_id` and forced RLS with `using` and `with check`; app code uses `withNewsroom()`.
7. No channels, credentials or secrets in config; no new env secret beyond `.env.example` without updating `docs/technical-design.md`.
8. Disclosure cannot be turned off; every template renders the disclosure partial.
9. A newsroom-specific need is solved by configuration, never by code that names a newsroom.
10. No graph waits for a human.

## 2. Boundaries (`docs/charter.md#what-anr-is-not`)

Flag anything that moves ANR toward a content farm, autonomous agenda-setting, a general CMS or page builder, a social scheduler, a public aggregator, a breaking-news wire, or an in-house agent framework. Such a change needs a charter change first.

## 3. Docs

- Does `docs/` still describe the system after this change?
- Is any new decision recorded in `docs/decisions.md`?
- Does `docs/` contain anything undecided? It must not; undecided items go to GitHub issues.

Finish with a one-line verdict: **clear**, or **blocked** with the invariant or boundary it crosses.
