@AGENTS.md

## Claude Code notes

- Skills in `.claude/skills/` cover the common changes; use them instead of improvising.
- Run `pnpm check` before saying a change is done; quote failures rather than summarising them away.
- Dev servers for the browser pane are in `.claude/launch.json` (`web` on :4321, `api` on :8787). Newsroom sites resolve by host: http://ai.localhost:4321/ and http://kultur.localhost:4321/.
- Before a change that touches agents, publishing, tenancy or disclosure, run the `charter-check` skill on the diff.
