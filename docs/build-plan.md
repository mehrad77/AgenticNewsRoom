# Build plan

The seven milestones from the [technical design](technical-design.md#build-order), broken into tasks an agent or a person can take one at a time. A milestone starts only after the previous gate passes. Tick a task in the same pull request that finishes it.

Each task is done when its code is merged with tests, `pnpm check` passes, and the docs still describe the system.

## 0. Scaffold

- [x] Monorepo: pnpm workspaces, Turborepo, uv workspace, Biome, ruff, mypy, vitest, pytest.
- [x] Stubs that start and pass a test: `api`, `web`, `agents`, `publisher`, `ingestion`, `verifier`.
- [x] JSON Schemas for config files and formats; zod and pydantic codegen with a drift check.
- [x] Config for both newsrooms, validated by `pnpm config:check`.
- [x] Model router with the fact-checker rule; Liquid renderer with the disclosure partial.
- [x] CI, Docker Compose, Dockerfiles, Caddyfile; `AGENTS.md`, skills.
- [x] IPTC vocabularies and the ninjs 3.2 schema vendored in `packages/schemas/iptc/`; beats mapped to Media Topics and formats to genres, checked by `pnpm config:check`.

## 1. Foundation

Gate: **config loads, and a backup restores into a fresh database.** Locally, until milestone 7 (D53).

- [x] Database roles for production (`anr_migrator`, `anr_app`, `anr_system`) created from environment passwords.
- [x] Migrations for the data model in `technical-design.md#data-model`, every tenant table with forced RLS (`add-migration` skill).
- [x] `anr.normalize_text()` SQL function, tested against `packages/schemas/fixtures/normalization.json`.
- [x] CI check: every table with a `newsroom_id` column has RLS enabled, forced, and a policy.
- [x] RLS integration tests: `anr_app` cannot read or write another newsroom's rows; a pooled connection does not leak `anr.newsroom_id`.
- [x] Config sync (`packages/config`): upsert newsrooms, beats, sources and series with stable ids, soft-delete removed items, reconcile pg-boss schedules in each newsroom's timezone. Runs at deploy under `anr_system`.
- [x] pg-boss schema installed; worker skeletons subscribe to their queues.
- [x] Platform key: encrypt and decrypt channel credentials (AES-256-GCM) with tests.
- [x] Audit log table and a helper every approval and edit goes through.
- [x] pgBackRest with continuous WAL archiving and a restore drill, rehearsed locally against an S3 stand-in (`infra/backup/drill-local.sh`).
- [x] Compose `prod` profile: migrations and config sync before the apps; `infra/deploy.sh` refuses unsafe settings.
- [x] Gate: `infra/backup/drill-local.sh` backs up, loses the database, restores it into an empty volume and runs the tenancy check, `pnpm config:check` and config sync against it.

## 2. Ingestion

Gate: **the AI newsroom's sources fill the lead pool.**

- [x] Fetchers for RSS, API and site sources (httpx, feedparser), with per-source rate limits and a refusal of private and internal addresses.
- [x] Text extraction (trafilatura); raw page stored (a local directory until milestone 7, then R2; D55); headline, byline, language and dates kept under their ninjs names.
- [x] Deduplication: canonical URL, content hash, near-duplicate text; a syndicated copy joins the original lead.
- [x] Tiering: source tier; papers mapped from the credibility rules (high 1, medium 2, low 3, flagged dropped).
- [x] Lead storage with frozen text; internal HTTP endpoint the pg-boss job calls.
- [x] High-priority "request a source" path that returns the lead (for agents), tier 3 for unknown sites, capped per run.
- [x] Summariser graph (Flash-Lite): summary and beats per new lead (its IPTC subjects are the beats' Media Topics), logged as an Agent run.
- [x] Complete the AI newsroom's `sources.yaml` (one entry per lab blog, arXiv categories), each with verified URL; a person reads each source's terms and sets `terms_checked`.
- [ ] Gate: a week of scheduled runs fills the AI lead pool with no duplicates across sources. *Waiting on the week of runs; proven on recorded fixtures by `apps/agents/src/pipeline.db.test.ts`.*

## 3. Desk and verifier

Gate: **a daily brief is drafted, then passes or is held with reasons.**

- [x] Model gateway (`@anr/models`): role chains with fallback on rate limits, outages and retired models; fact-checker excluded by model family; free development profile (`ANR_MODELS=free`) and `pnpm models:probe`.
- [x] Agent tool layer: read lead, search lead pool (trigram search), request source, submit; nothing else reachable.
- [x] Prompt assembly: role prompt + newsroom `style.md` + format `guide.md`, versioned, under 5 KB.
- [x] Submit validation against the format schema; one retry with errors, then hold.
- [x] Budgets: per-run token caps per format, monthly spend cap per newsroom, 80% notice, writing paused at the cap with a reserved budget for checks.
- [x] Desk graph: read → outline → draft → claims with quotes → validate.
- [x] Verifier code checks (Python): schema, quote match after normalisation, source independence, beats, item–claim consistency (numbers, dates, names), disclosure label, per-language style lint; format `checks.yaml` rules.
- [x] Fact-checker graph: one claim and passage at a time, model chosen by the router.
- [x] Item matcher graph: each rendition item against its claims.
- [x] Policy layer: holds, themed and restricted routing, daily news scheduling; every result stored as a Check.
- [x] Daily assignment job at 16:00 from the last 24 hours of leads, ranked by tier.
- [x] Gate: a daily newsletter issue is drafted in fa and en and either passes or is held with stored reasons.

## 4. Publishing

Gate: **daily news publishes end to end on its own.**

- [x] Publisher sweep: approved and scheduled publications whose slot has come.
- [x] Idempotent send with Post rows; unknown results held; past-due slots held after a restore.
- [x] Telegram channel via the Bot API, with message splitting at 4,096 characters.
- [x] Reader site: publication pages per language, `lang`/`dir` per page, disclosure label, schema.org JSON-LD with IPTC digital source type, Media Topics and genre, AI policy and corrections pages.
- [x] ninjs 3.2 twin of every published publication at its page URL plus `.json`, with subjects, genres, digital source type and trust indicators; tests validate it against `packages/schemas/iptc/ninjs-schema_3.2.json`.
- [x] Site search over normalised text.
- [x] Editor's desk behind Cloudflare Access: JWT verification, memberships, review queue with holds and their reasons, approve or return, channel management with encrypted credentials.
- [ ] 10% random review sample of auto-published publications, with a "miss" action that files a new check or policy rule. *Sample, review and recorded misses done (D94); filing a check or rule from a miss is not.*
- [x] Audience counters: cookieless page views; daily Telegram subscriber snapshots.
- [ ] Gate: a week of daily newsletters publishes to the site and Telegram with no manual step.

## 5. Planning and podcasts

Gate: **one editorial cycle runs from plan to published pieces.**

- [ ] Planner graph: themes for each editorial cycle (2–3 with angle and calendar, cycles from `planning` in `newsroom.yaml`) and weekly candidates (three per series).
- [ ] Desk screens for choosing and editing a theme and picking a candidate; pick deadline skips the slot and notifies the editor.
- [ ] Renderer graph: another language or format from a story; weekly podcast scripts from the week's published renditions.
- [ ] Verifier checks for story segments: arc complete and in order, protagonists grounded, turning point and resolution name a protagonist, cues and directions sparse, AI voices introduced.
- [ ] Stock sound-cue assets per series (sting, bed swell, bed out, transition), all owned or licensed for use.
- [ ] Podcast pipeline: Gemini TTS per segment with the narrator voice and delivery directions as style prompts (cached by text, voice and direction), sound cues mixed from stock assets, ffmpeg mix to −16 LUFS MP3, ID3 tags and chapters, upload to R2.
- [ ] Podcast RSS per language, download counting through the site redirect.
- [ ] C2PA signing with c2patool's built-in certificate; the `c2pa.actions` assertion carries the publication's IPTC digital source type.
- [ ] Gate: one full editorial cycle for the AI newsroom (its one-month cycle: theme, four classic papers, four podcasts in fa and en), and listening tests confirm the English and Turkish voices are fit to publish.

## 6. Safeguards and the second newsroom

Gate: **v1 done: Kültür starts with no new code.**

- [ ] Reader challenges: form on every publication, owner, 24-hour acknowledgement and 48-hour answer deadlines with reminders.
- [ ] Corrections: published correction notice, publication status Corrected, each correction linked to the new check it adds.
- [ ] Marked opinion in templates and verifier for `opinion: allowed_marked` newsrooms.
- [ ] Media items with IPTC Photo Metadata read from XMP on ingest and written back on publish; publisher refuses unlicensed media.
- [ ] Measures view in the desk: hold rate, sample misses, corrections per 100 publications, editor minutes per week, cost per publication, audience per language.
- [ ] Complete Kültür's `sources.yaml`: Turkish music press, label release feeds, venue calendars, festival line-ups, each with a verified URL and `terms_checked`.
- [ ] Gate: Kültür goes live from its config folder, a DNS record and channels set up in the desk, with no code change.

## 7. Deploy

Gate: **a backup restores onto a fresh machine.** Starts after milestone 6 (D53).

- [ ] Decide how the laptop is reached from the internet and where its backups go (issue #2).
- [ ] Backups off the laptop with continuous WAL archiving (`infra/backup/backup.sh`, cron in `infra/AGENTS.md`).
- [ ] Production `.env` (`infra/deploy.sh --check`) and the Compose `prod` profile running on the laptop, with TLS for the root domain and every newsroom subdomain.
- [ ] Gate: restore the latest backup onto a fresh machine and run `pnpm config:check` plus config sync against it (`infra/backup/restore-drill.sh`).
