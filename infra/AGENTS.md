# infra

One server runs everything with Docker Compose: a Linux VM or dedicated server, or the operator's laptop, where ANR's own newsrooms run (D145); until milestone 7a only in dev (D53). Postgres holds data and the pg-boss queue; R2 holds pgBackRest backups, and from milestone 7a raw pages, audio and images (D132). Design: [`docs/technical-design.md#deploy-and-backups`](../docs/technical-design.md#deploy-and-backups) and [operations](../docs/technical-design.md#operations-and-observability). Items marked *7a* or *7b* are planned in that milestone and do not exist yet.

## Production topology

Prod is the Compose project `anr-prod` (*7a*); where dev shares the machine, as on the operator's laptop, it is project `anr` (Postgres on 5432, apps run with `pnpm dev`) (D126). Prod has its own volumes, Postgres on `127.0.0.1:5433`, and no other published port. Readers and editors reach it only through Cloudflare: `cloudflared` holds an outbound-only tunnel, Cloudflare terminates TLS and Access guards `desk.` and `ops.` (D122, D123). The tunnel sends every host to Caddy over plain HTTP; Caddy routes `ops.` to Grafana, `/api/*` on `desk.` to the API and the rest to the web app. Telemetry goes from every app over OTLP to the OTel Collector and on to `grafana/otel-lgtm` (*7b*). No container gets the Docker socket.

## Files

- `compose.yaml`: Postgres for dev (`pnpm db:up`); the `prod` profile adds the one-shot `migrate` and `config-sync` jobs, the apps, the Python services and Caddy. Apps start only after both jobs succeed, and reach Postgres at host `postgres` with URLs built from the role passwords. *7a:* run as project `anr-prod` with images from GHCR by `ANR_VERSION`, `cloudflared`, stock Caddy on plain HTTP; *7b:* the collector and otel-lgtm.
- `docker/postgres.Dockerfile`: Postgres 17 with pgBackRest and `anr-roles`, the same image in dev and production.
- `postgres/`: `anr-roles` creates the roles (`anr_migrator`, `anr_app`, `anr_system`) and databases from the env passwords on first start, and rotates passwords when run again (`pnpm db:roles` in dev; `deploy.sh` runs it on every deploy).
- `Caddyfile`: today wildcard TLS via Cloudflare DNS-01; *7a:* plain-HTTP routing behind the tunnel, with the custom build (`docker/caddy.Dockerfile`) and the DNS token removed.
- `deploy.sh`: refuses a `.env` with dev passwords, a malformed platform key, archiving off or missing backup settings (`--check` checks only), then builds, applies role passwords, checks backups and starts the stack. *7a:* `deploy.sh <tag>` decrypts `secrets/prod.env`, requires `ANR_PUBLISH=live`, pulls the tag's images instead of building, and `--check` refuses a host disk under 10% free and, on macOS, warns when sleep is on for AC power.
- `backup/`: pgBackRest to R2 (`backup.sh init|full|diff|incr|check|info`), `restore.sh` into an empty volume, `restore-drill.sh` (milestone 7a's gate on a fresh machine), and `drill-local.sh` (milestone 1's gate), which rehearses backup, WAL replay and restore locally against an S3 stand-in.
- *7a* `terraform/`: Cloudflare tunnel, DNS, Access and R2 buckets (D136). The operator runs `plan` and `apply`; state is in its own R2 bucket.
- *7a* `secrets/`: `prod.env`, the production env, and `terraform.tfvars.json`, the Access allow-lists, both SOPS-encrypted with age (D125); `.sops.yaml` at the repo root names the recipient.
- *7a* `host/`: host profiles (D127). `linux/`: systemd timers and services for the backup schedule and the desk's backup-check requests (D131). `macos/`: the same as launchd agents, plus one running `caffeinate -s`.
- *7b* `observability/`: collector config, Grafana datasources, dashboards and alert rules, provisioned read-only.
- *7b* `drills/`: chaos drills (a host outage across a slot, kill a worker, fill a scratch volume to 15% disk free) and their runbooks (D143).

## Backups

pgBackRest archives every WAL segment to R2 (at least every 5 minutes), takes a full backup weekly and a differential daily, keeps four full backups, and encrypts the repository with `ANR_BACKUP_PASSPHRASE`. A restored copy runs with archiving off, so it never writes into the production repository. Neither the backup passphrase nor the platform key is in a backup: keep both outside the server.

*7a:* the host profile runs `backup.sh full` (Sunday 03:00), `diff` (03:00 other days) and `check` (every 30 minutes): systemd timers with `Persistent=true` on Linux, launchd agents on macOS. Both run a job missed while the host was down or asleep once when it is back; cron would skip it (D131). Each run writes a `backup_runs` row, and a one-minute job runs the checks the desk asks for.

If `check` fails, WAL is not reaching R2 and Postgres keeps every segment until it does, so the disk fills; the backup and disk alerts (*7b*) catch it.

## First deploy

Milestone 7a (`docs/build-plan.md`). The operator does the steps with accounts and keys; the files they use are 7a's agent tasks.

1. Cloudflare: the zone for `ANR_ROOT_DOMAIN`, a Zero Trust team, R2. By hand: the Terraform state bucket with a token scoped to it, and a Cloudflare API token for Terraform; both in the password manager.
2. age, on the server as the deploying user: `age-keygen -o ~/.config/sops/age/keys.txt` (mode 600), a copy in the password manager, the public key in `.sops.yaml`.
3. `terraform plan` and `apply` in `terraform/` (*7a*): tunnel, root and wildcard DNS records, Access for `desk.` and `ops.`, R2 buckets. Then by hand an R2 token for ANR's buckets.
4. `sops infra/secrets/prod.env` (*7a*) with production values: role passwords from `openssl rand -hex 32`, `ANR_PLATFORM_KEY` from `openssl rand -base64 32` (not dev's), `ANR_BACKUP_PASSPHRASE`, R2 keys and buckets, model keys, `CLOUDFLARE_TUNNEL_TOKEN` from Terraform's output, `ANR_PUBLISH=live`, `ANR_WAL_ARCHIVE=on`, `ANR_DATABASES=anr`. Keep the platform key and the backup passphrase in the password manager too.
5. The host profile (*7a*). Linux: Docker Engine with the Compose plugin, the repo at `/opt/anr`, the units in `host/linux/` enabled, Docker enabled at boot. macOS: `sudo pmset -c sleep 0 disksleep 0`, the agents in `host/macos/` loaded, Docker started at login; the lid stays open, or closed only with an external display, and after a reboot someone must log in.
6. `infra/deploy.sh --check`, then `infra/deploy.sh <tag>` (*7a*), then `infra/backup/backup.sh full`.
7. Gate: `infra/backup/restore-drill.sh` on a fresh machine, then `pnpm config:check` and config sync against it.
