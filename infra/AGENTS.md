# infra

One VM (Hetzner Cloud, 4 dedicated vCPU / 16 GB) runs everything with Docker Compose. Postgres holds data and the pg-boss queue; R2 holds audio, raw source snapshots and pgBackRest backups.

- `compose.yaml`: Postgres for dev (`pnpm db:up`); the `prod` profile adds the one-shot `migrate` and `config-sync` jobs, the apps, the Python services and Caddy. Apps start only after both jobs succeed, and reach Postgres at host `postgres` with URLs built from the role passwords.
- `docker/postgres.Dockerfile`: Postgres 17 with pgBackRest and `anr-roles`, the same image in dev and production.
- `postgres/`: `anr-roles` creates the roles (`anr_migrator`, `anr_app`, `anr_system`) and databases from the env passwords on first start, and rotates passwords when run again (`pnpm db:roles` in dev; `deploy.sh` runs it on every deploy).
- `Caddyfile`: wildcard TLS via Cloudflare DNS-01; only `web` and `api` are public.
- `deploy.sh`: refuses a `.env` with dev passwords, a malformed platform key, archiving off or missing backup settings (`--check` checks only), then builds, applies role passwords, checks backups and starts the stack.
- `backup/`: pgBackRest to R2 (`backup.sh init|full|diff|incr|check|info`), `restore.sh` into an empty volume, `restore-drill.sh` (the milestone 1 gate on a fresh VM), and `drill-local.sh`, which rehearses backup, WAL replay and restore on a laptop against a local S3 stand-in.

## Backups

pgBackRest archives every WAL segment to R2 (at least every 5 minutes), takes a full backup weekly and a differential daily, keeps four full backups, and encrypts the repository with `ANR_BACKUP_PASSPHRASE`. A restored copy runs with archiving off, so it never writes into the production repository. Neither the backup passphrase nor the platform key is in a backup: keep both outside the VM.

Cron on the VM (repo at `/opt/anr`):

```
0 3 * * 0    cd /opt/anr && infra/backup/backup.sh full 2>&1 | logger -t anr-backup
0 3 * * 1-6  cd /opt/anr && infra/backup/backup.sh diff 2>&1 | logger -t anr-backup
*/30 * * * * cd /opt/anr && infra/backup/backup.sh check 2>&1 | logger -t anr-backup
```

If `check` fails, WAL is not reaching R2 and Postgres keeps every segment until it does, so the disk fills.

## First deploy

1. Cloudflare: the root domain's zone; an API token with `Zone.DNS:Edit` for it (`CLOUDFLARE_DNS_API_TOKEN`); DNS `A` records for the root and `*` pointing at the VM.
2. R2: a bucket for backups (`ANR_BACKUP_BUCKET`) and an API token with read and write on it (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
3. Hetzner: a CCX23 VM with Docker; firewall open on 22, 80 and 443 only; the repo at `/opt/anr`.
4. `.env` from `.env.example` with production values: role passwords from `openssl rand -hex 32`, `ANR_PLATFORM_KEY` from `openssl rand -base64 32`, `ANR_BACKUP_PASSPHRASE`, `ANR_WAL_ARCHIVE=on`, `ANR_DATABASES=anr`. Store the platform key and the backup passphrase in a password manager.
5. `infra/deploy.sh --check`, then `infra/deploy.sh`, then `infra/backup/backup.sh full` and the cron entries above.
