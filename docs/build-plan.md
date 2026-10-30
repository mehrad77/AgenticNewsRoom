# Build plan

The milestones from the [technical design](technical-design.md#build-order), broken into tasks an agent or a person can take one at a time. A milestone starts only after the previous gate passes. Tick a task in the same pull request that finishes it.

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
- [x] 10% random review sample of auto-published publications, with a "miss" action that files a new check or policy rule (D94, D102).
- [x] Audience counters: cookieless page views; daily Telegram subscriber snapshots.
- [ ] Gate: a week of daily newsletters publishes to the site and Telegram with no manual step.

## 5. Planning and podcasts

Gate: **one editorial cycle runs from plan to published pieces.**

- [x] Planner graph: themes for each editorial cycle (2–3 with angle and calendar, cycles from `planning` in `newsroom.yaml`) and weekly candidates (three per series).
- [x] Desk screens for choosing and editing a theme and picking a candidate; pick deadline skips the slot and notifies the editor.
- [x] Renderer graph: another language or format from a story; weekly podcast scripts from the week's published renditions.
- [x] Verifier checks for story segments: arc complete and in order, protagonists grounded, turning point and resolution name a protagonist, cues and directions sparse, AI voices introduced.
- [x] Stock sound-cue assets per series (sting, bed swell, bed out, transition), all owned or licensed for use.
- [x] Podcast pipeline: Gemini TTS per segment with the narrator voice and delivery directions as style prompts (cached by text, voice and direction), sound cues mixed from stock assets, ffmpeg mix to −16 LUFS MP3, ID3 tags and chapters, upload to R2 (a local store behind the same interface until milestone 7, D109).
- [x] Podcast RSS per language, download counting through the site redirect.
- [x] C2PA signing with c2patool's built-in certificate; the `c2pa.actions` assertion carries the publication's IPTC digital source type.
- [ ] Gate: one full editorial cycle for the AI newsroom (its one-month cycle: theme, four classic papers, four podcasts in fa and en), and listening tests confirm the English and Turkish voices are fit to publish.

## 6. Safeguards and the second newsroom

Gate: **v1 done: Kültür starts with no new code.**

- [x] Reader challenges: form on every publication, owner, 24-hour acknowledgement and 48-hour answer deadlines with reminders.
- [x] Corrections: published correction notice, publication status Corrected, each correction linked to the new check it adds.
- [x] Marked opinion in templates and verifier for `opinion: allowed_marked` newsrooms.
- [x] Media items with IPTC Photo Metadata read from XMP on ingest and written back on publish; publisher refuses unlicensed media.
- [x] Measures view in the desk: hold rate, sample misses, corrections per 100 publications, editor minutes per week, cost per publication, audience per language (D99; done in milestone 4).
- [ ] Complete Kültür's `sources.yaml`: Turkish music press, label release feeds, venue calendars, festival line-ups, each with a verified URL and `terms_checked`. *21 sources with verified URLs are in; waiting on a person to read each one's terms and set `terms_checked`.*
- [ ] Gate: Kültür goes live from its config folder and channels set up in the desk, with no code change (the wildcard DNS record covers its subdomain, D122). *Proven locally: `apps/agents/src/kultur.db.test.ts` syncs the config folder and takes a weekly artist story through the desk, renderer and gate in tr, en and fa, and `kultur.localhost` serves the site; waiting on `terms_checked` and channels.*

## 7a. Deploy

Gate: **a backup restores onto a fresh machine, and `pnpm config:check` and config sync run against it.** Starts after milestone 6's gate (D53, D133). Design: [Deploy and backups](technical-design.md#deploy-and-backups).

Operator tasks (accounts, keys and anything run against Cloudflare; an agent cannot do these):

- [ ] Cloudflare: the root domain's zone on Cloudflare (nameservers moved), a Zero Trust team, R2 enabled. *Done when the zone is active.*
- [ ] Terraform bootstrap: a private R2 bucket for Terraform state and an R2 token scoped to it; a Cloudflare API token for Terraform (DNS, Tunnel, Access and R2 edit on this account and zone). Both in the password manager (D136). *Done when `terraform init` connects to the state bucket.*
- [ ] age key: `age-keygen` on the server, as the deploying user, into `~/.config/sops/age/keys.txt` (mode 600), a copy in the password manager; give the public key to the `.sops.yaml` task (D125).
- [ ] Access allow-lists: the desk's email list and the operator's own for `ops.`, entered with `sops infra/secrets/terraform.tfvars`. *Done when the file is committed encrypted.*
- [ ] `terraform plan` and `apply` in `infra/terraform/`. *Done when the tunnel, DNS records, Access apps and R2 buckets exist, a second `plan` shows no changes, and a `plan` run while another holds the lock is refused.*
- [ ] R2 API token for ANR's buckets (backups, raw, media), made by hand. *Done when `infra/backup/backup.sh check` reaches the backups bucket.*
- [ ] Production env: `sops infra/secrets/prod.env` with every value: role passwords (`openssl rand -hex 32`), platform key (`openssl rand -base64 32`, different from dev), backup passphrase, R2 keys, model keys, the tunnel token from Terraform's output, `ANR_PUBLISH=live`, `ANR_WAL_ARCHIVE=on`, `ANR_DATABASES=anr`. Platform key and backup passphrase also in the password manager. *Done when `infra/deploy.sh --check` passes.*
- [ ] The server, by its host profile (D127). Linux: Docker Engine with the Compose plugin, the repo at `/opt/anr`, the units from `infra/host/linux/` enabled, Docker enabled at boot. macOS: `sudo pmset -c sleep 0 disksleep 0`, the agents from `infra/host/macos/` loaded, Docker set to start at login. *Done when `infra/deploy.sh --check` passes with no warning and the backup timers or agents are listed.*
- [ ] GitHub: install the Renovate app on the repository; push the first version tag; make the GHCR packages public. *Done when Renovate opens its dependency dashboard and an anonymous `docker pull` of a tagged image works.*
- [ ] First deploy: `infra/deploy.sh <tag>`, then `infra/backup/backup.sh full`. *Done when the AI newsroom's site answers through the tunnel and `/healthz` is 200.*
- [ ] Gate: `infra/backup/restore-drill.sh` on a fresh machine (age key and passphrase from the password manager), then `pnpm config:check` and config sync against the restored database.

Agent tasks:

- [ ] Terraform in `infra/terraform/`: Cloudflare provider pinned in the lock file; S3 backend on the R2 state bucket with the lockfile; the tunnel with one ingress rule (root and wildcard hosts to `http://caddy:80`); proxied root and `*` records; Access applications and policies for `desk.` and `ops.` from SOPS-encrypted variables; R2 buckets for backups, raw pages and media; allow-lists read from `infra/secrets/terraform.tfvars` with `sops exec-file`. CI runs `terraform fmt -check`, `validate` and tflint. *Done when CI passes without credentials.*
- [ ] Prod Compose project `anr-prod`: own volumes, Postgres on `127.0.0.1:5433`, no other published port; `cloudflared` (token from env); Caddy as the stock image on plain HTTP routing `ops.` to Grafana, `/api/*` on `desk.` to the API and the rest to web; the custom Caddy build and its DNS module removed; images from `ghcr.io/<owner>/anr-*:${ANR_VERSION}`; `restart: unless-stopped` everywhere (D122, D126). *Done when `docker compose -p anr-prod config` validates and a local run serves a newsroom page through Caddy with no tunnel.*
- [ ] `.env.example` and `infra/deploy.sh` follow D124 and D126: `CLOUDFLARE_TUNNEL_TOKEN` and `ANR_OPS_TELEGRAM_BOT_TOKEN` in, `CLOUDFLARE_DNS_API_TOKEN` out, `ANR_PUBLISH`, `ANR_VERSION`, `ANR_OPS_TELEGRAM_CHAT_ID`; deploy requires `ANR_PUBLISH=live`; `--check` refuses a host disk under 10% free and, on macOS, warns when sleep is on for AC power. *Done when the docs' secrets list, `.env.example` and deploy's required list match.*
- [ ] SOPS: `.sops.yaml` with the operator's age public key; `infra/secrets/prod.env` as an encrypted placeholder; `infra/deploy.sh` decrypts it for the deploy only; a CI check fails on any file in `infra/secrets/` that is not SOPS-encrypted (D125). *Done when a plaintext file in `infra/secrets/` fails CI.*
- [ ] Release workflow: on a version tag, build every image for `linux/arm64` and `linux/amd64` (native arm64 runners), Trivy scan failing on fixable HIGH or CRITICAL with SARIF uploaded, SBOM and provenance attached, push to GHCR with the tag and the commit SHA (D134). *Done when the workflow passes on a pull request in build-and-scan-only mode, and `infra/deploy.sh` takes a tag instead of building.*
- [ ] Expand-then-contract migrations in the `add-migration` skill and `packages/db/AGENTS.md`: a migration never breaks the previous tag; drops and renames wait a release (D134). *Done when both say so with an example.*
- [ ] Renovate config: groups, `minimumReleaseAge` 3 days, Actions and image digests pinned, pnpm, uv, Dockerfiles, Compose, GitHub Actions and Terraform managers, dependency dashboard, automerge for dev-dependency patches on green CI (D135). *Done when `renovate-config-validator` passes in CI.*
- [ ] Dev never publishes: the publisher sends to an external channel only with `ANR_PUBLISH=live`, otherwise records a dry run; tests for both (D126).
- [ ] Reserved subdomains: config validation rejects a newsroom with subdomain `desk` or `ops` (D123). *Done when a test with each fails validation.*
- [ ] Reader addresses from `CF-Connecting-IP` for download counting and the challenge rate key (D122). *Done when tests show a forged `X-Forwarded-For` is ignored.*
- [ ] Host profiles in `infra/host/` (D127): `linux/` systemd timers with `Persistent=true` and services; `macos/` launchd agents, plus one running `caffeinate -s` and the `pmset` steps in `infra/AGENTS.md`. Both run the backup schedule and the desk's check requests (next task). *Done when `systemd-analyze verify` and `plutil -lint` pass on them in CI.*
- [ ] Heartbeats and outages: every worker beats every 30 s; gaps over 3 minutes recorded as worker or host outages with start and end; platform tables with their stated reason for the tenancy check; `/healthz` (D128). *Done when killing a worker for 4 minutes leaves one outage row.*
- [ ] Missed slots: `grace` in the format schema and every `format.yaml` (newsletter 30m, podcast 1h, classic article and artist story 2h); the publisher holds a send past its grace with a `missed-slot` check and a `slot-missed` notice; the podcast audio wait ends at grace (D129). *Done when config validation requires `grace` and tests cover a send just inside and just past it.*
- [ ] Once after a gap: a gap starts one catch-up per schedule for its latest due period (keyed by schedule and period); sweeps never replay; a challenge's "due" reminder is skipped once its deadline passed; a daily assignment whose slot passed sends `slot-missed`. A test moves an injected clock across a 3-hour gap and checks every row of the after-a-gap table in the technical design (D130).
- [ ] Backups from the host's scheduler: timers and agents in `infra/host/` for the weekly full, daily differential and 30-minute check, and a one-minute job for the desk's check requests; `backup.sh` writes `backup_runs`; `infra/AGENTS.md`'s cron lines replaced (D131). *Done when a local run against the S3 stand-in writes a `backup_runs` row.*
- [ ] Object storage: raw pages to `ANR_RAW_BUCKET` (D55), episode audio and published images to the media bucket (D109, D120); `/a/` and `/m/` redirect to presigned URLs valid for an hour (D132). *Done when an episode download and an image are served from R2 in a local run against a test bucket.*
- [ ] Desk Ops page for the platform admin: pause publishing per newsroom (`publishing_pauses`, tenant table with forced RLS) or everywhere (a `platform_settings` key); retry a failed job; cancel a not-yet-started job or drain a queue only on the allowed queues in D144; run a backup check now (`ops_requests`); drains in `queue_drains`; every action in `platform_audit_log`; the publisher, workers and backup agent obey within 30 seconds; a resumed publication sends only within its grace (D144). *Done when tests show a paused newsroom sends nothing, a drained queue takes no new job, cancel and drain are refused for `publish-correction`, `assign`, `redraft` and the deadline queues, and each action is audited.*
- [ ] Docs: `infra/AGENTS.md` describes the deployed system. *Done when its first-deploy steps were followed as written.*

## 7b. Observability

Gate: **a simulated outage shows in Grafana and fires its alert: the host down across a slot, a killed worker and a filled disk, each with a postmortem.** Starts after 7a's gate (D133). Design: [Operations and observability](technical-design.md#operations-and-observability).

Operator tasks:

- [ ] Ops Telegram bot from BotFather, its token in `infra/secrets/prod.env`, the operator's chat id as `ANR_OPS_TELEGRAM_CHAT_ID`. Not a newsroom channel (D140). *Done when Grafana's test notification arrives.*
- [ ] UptimeRobot (free plan): an HTTPS monitor on `https://$ANR_ROOT_DOMAIN/healthz` every 5 minutes, alerting by its app's push and email (D141). *Done when stopping `cloudflared` for 10 minutes alerts the operator.*
- [ ] Run the real host-outage drill across a newsletter slot (spending error budget on purpose): stop the VM or reboot it on Linux, `pmset sleepnow` on macOS; write its postmortem.

Agent tasks:

- [ ] Telemetry stack in the prod profile: `grafana/otel-lgtm` pinned by digest on its own volume (metrics 30 days, logs and traces 7 days) and the OTel Collector (contrib) receiving OTLP, reading the Docker log files of Postgres, Caddy and cloudflared read-only, reporting the host's disk and memory (on macOS, Docker's VM), and dropping client addresses, user agents, `CF-Connecting-IP` and URL query strings; memory limits from a measured baseline within 2 GB (D137, D139). Start with a spike that reads Docker's log files and the volumes' disk on both host profiles. *Done when a test span with a client address and a query string arrives in Tempo without them, and the baseline and limits are recorded in `infra/AGENTS.md`.*
- [ ] Grafana at `ops.` behind Access: JWT sign-in from the Access token with the ops application's audience, the operator as Editor; login form, basic auth and anonymous access off; datasources, dashboards and alert rules provisioned read-only from `infra/observability/` (D123, D139). *Done when a request without the Access JWT is refused and no dashboard can be saved from the UI.*
- [ ] `packages/telemetry` and the Node SDK in api, web, agents and publisher: Hono, Astro, pg and HTTP instrumentation, a span per pg-boss job continued from `traceparent` in the job data, structured logs with trace ids over OTLP (D137). *Done when a desk request's log line opens its trace in Grafana.*
- [ ] The Python SDK in ingestion and verifier: FastAPI, httpx, psycopg, logs with trace ids over OTLP (D137). *Done when an ingest run's spans join the agents worker's `ingest-source` trace.*
- [ ] Publication traces: trace id stored on the publication at assignment; every job for it continues the trace; span links to the cited leads' ingest spans; the desk's publication page links to the trace in Grafana (D137). *Done when one daily issue shows desk, renderers, gate and publisher in one trace.*
- [ ] GenAI spans: `invoke_agent` per graph run, a span per LangGraph node, `chat` per model call with the GenAI attributes, `execute_tool` per tool call, `anr.cost_usd`, `anr.model.chain` and `anr.model.attempts`; no prompt or answer text; a test pins the attribute names (D138).
- [ ] Platform gauges from the agents worker every minute: queue depths, held publications and spend per newsroom (inside `withNewsroom()`), heartbeat ages, outages, backup runs, `pg_stat_archiver`; slot counters (sent on time, late, missed) from the publisher (D139). *Done when each gauge shows on its dashboard for both newsrooms, and a test proves the gauges read each newsroom under its own setting.*
- [ ] Dashboards as code: Overview, Queues, Publishing, Agents and spend, Backups and disk, Outages, Load tests. *Done when each loads from provisioning with data and no panel errors.*
- [ ] SLOs and alerts: the two SLOs with multi-window burn-rate alerts; backup check failed or missing, the volumes' disk at 20% and 10% free, lost heartbeat, tunnel without a connection, hold-rate spike, missed slot; the Telegram contact point (D140). *Done when each rule fires against test data.*
- [ ] k6 load tests in `tools/load/`: reader page, search, ninjs twin, podcast feed against the origin through Caddy; thresholds no errors and p95 under 500 ms at 20 requests a second; results to Grafana over OTLP (D142). *Done when a run passes and shows on the Load tests dashboard.*
- [ ] Chaos drills in `infra/drills/`: `docker compose pause` of `anr-prod` across a slot, killing a worker, filling a scratch volume until the volumes' disk is at 15% free, then removing it; each with a runbook (D143). *Done when each script runs and cleans up after itself.*
- [ ] Gate: each drill shows in Grafana and fires its alert in the ops chat, and has a postmortem in `docs/postmortems/` from the template.
