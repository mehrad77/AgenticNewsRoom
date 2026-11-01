# infra

One server runs everything with Docker Compose: a Linux VM or dedicated server, or the operator's laptop, where ANR's own newsrooms run (D145). Postgres holds data and the pg-boss queue; private R2 buckets hold pgBackRest backups, raw pages, episode audio and published images (D132). Design: [`docs/technical-design.md#deploy-and-backups`](../docs/technical-design.md#deploy-and-backups) and [operations](../docs/technical-design.md#operations-and-observability). Items marked *7b* are planned in milestone 7b and do not exist yet.

## Production topology

Prod is the Compose project `anr-prod` (`compose.prod.yaml`); where dev shares the machine it is project `anr` (`compose.yaml`, Postgres on 5432, apps run with `pnpm dev`) (D126, D146). Prod has its own volumes, Postgres on `127.0.0.1:${ANR_PG_PORT:-5433}`, and no other published port. Readers and editors reach it only through Cloudflare: `cloudflared` holds an outbound-only tunnel, Cloudflare terminates TLS and Access guards `desk.` and `ops.` (D122, D123). The tunnel sends every host to Caddy over plain HTTP; Caddy routes `ops.` to Grafana (*7b*), `/api/*` on `desk.` to the API and the rest to the web app. Apps read a reader's address only from `CF-Connecting-IP`. Each container gets only the variables it reads; apps reach Postgres as `anr_app` (D149). No container gets the Docker socket.

## Files

- `compose.yaml`: dev's Postgres (`pnpm db:up`).
- `compose.prod.yaml`: production, images from `${ANR_IMAGES}/anr-*:${ANR_VERSION}`; the one-shot `migrate` and `config-sync` jobs finish before any app starts. The server never builds.
- `compose.build.yaml`: adds builds of the same images for a local trial or the drill (`ANR_IMAGES=local ANR_VERSION=local`).
- `docker/`: one Node image per app (the publisher's adds ffmpeg, exiftool and c2patool built from source), one Python image per service, and Postgres 17 with pgBackRest and `anr-roles`.
- `postgres/`: `anr-roles` creates the roles (`anr_migrator`, `anr_app`, `anr_system`) and databases from the env passwords on first start, and rotates passwords when run again (`pnpm db:roles` in dev; `deploy.sh` runs it on every deploy).
- `Caddyfile`: stock Caddy, plain HTTP, no access log.
- `deploy.sh <tag>`: decrypts `secrets/prod.env` for the run (`env.sh`), refuses unsafe settings (dev values, `ANR_PUBLISH` not `live`, weak passwords, a non-base64 backup passphrase, a host disk under 10% free, a taken port, a restored copy not promoted), pulls the tag's images, applies the role passwords, checks WAL archiving, starts `anr-prod` and waits for `/healthz`. `--check` checks only; on macOS it warns when sleep is on for AC power (D127). `--promote-restore <tag>` makes a restored copy production.
- `env.sh`: loads the production env as data, never as shell; clears every `.env.example` name from the shell first, so a dev value cannot leak in (D147).
- `check.ts`: run by `pnpm lint` and the opt-in pre-commit hook (`git config core.hooksPath .githooks`); fails on any file in `secrets/` that is not SOPS-encrypted, and when `.env.example`'s secrets differ from `env.sh`'s.
- `secrets/`: `prod.env` and `terraform.tfvars.json`, SOPS-encrypted to the operator's age key named in `.sops.yaml` (D125). Edit with `sops infra/secrets/prod.env`; the key is `~/.config/sops/age/keys.txt` (the scripts set `SOPS_AGE_KEY_FILE`, since sops on macOS looks elsewhere).
- `terraform/`: the tunnel and its ingress, root and wildcard records, Access for `desk.` and `ops.`, and the R2 buckets (D136). Run through `tf.sh`, which decrypts the variables per command; state is in the `anr-terraform-state` bucket, locked.
- `backup/`: pgBackRest to R2 (`backup.sh init|full|diff|incr|check|requests|info`, each run a `backup_runs` row), `restore.sh` into an empty volume, `restore-drill.sh <tag>` (7a's gate on a fresh machine) and `drill-local.sh` (the whole cycle against an S3 stand-in, milestone 1's gate). Running jobs use `docker exec` on the running container, so the host's scheduler needs no env.
- `host/`: host profiles (D127). `linux/`: systemd user units with lingering (`install.sh`). `macos/`: launchd agents (`install.sh`), plus one running `caffeinate -s`.
- *7b* `observability/`: collector config, Grafana datasources, dashboards and alert rules, provisioned read-only.
- *7b* `drills/`: chaos drills and their runbooks (D143).

## Backups

pgBackRest archives every WAL segment to R2 (at least every 5 minutes), takes a full backup weekly and a differential daily, keeps four full backups, and encrypts the repository with `ANR_BACKUP_PASSPHRASE`; it has its own R2 token, scoped to the backups bucket (D149). A restored copy runs with archiving off and is marked as a restored copy, so it never writes into the production repository until `deploy.sh --promote-restore`. Neither the backup passphrase nor the platform key is in a backup: keep both outside the server.

The host profile runs `backup.sh full` (Sunday 03:00), `diff` (03:00 other days), `check` (every 30 minutes) and `requests` (every 30 seconds, the desk's "check now"): systemd timers with `Persistent=true` on Linux, launchd agents on macOS. Both run a job missed while the host was down or asleep once when it is back; cron would skip it (D131, D150). A job waits up to 5 minutes for Postgres, so a catch-up at boot or wake does not fail before Docker is up. Logs: `journalctl --user -u 'anr-*'` on Linux, `~/Library/Logs/anr/` on macOS.

If `check` fails, WAL is not reaching R2 and Postgres keeps every segment until it does, so the disk fills; the backup and disk alerts (*7b*) catch it.

## Useful commands

```bash
infra/deploy.sh --check                     # production env and host
docker compose -p anr-prod ps               # the prod project, no env needed
docker compose -p anr-prod logs -f publisher
infra/backup/backup.sh info                 # backups and the WAL range
infra/host/linux/install.sh                 # or infra/host/macos/install.sh
```

## First deploy

Milestone 7a (`docs/build-plan.md`). The operator does the steps with accounts and keys. On macOS, use a clone of its own as the deploy checkout, so switching branches in dev never changes prod's scripts.

1. Cloudflare: the zone for `ANR_ROOT_DOMAIN`, a Zero Trust team with One-time PIN login, R2. By hand: the `anr-terraform-state` bucket with an R2 token scoped to it, and a Cloudflare API token for Terraform (Account: Cloudflare Tunnel, Access: Apps and Policies, Workers R2 Storage, all Edit; Zone: DNS Edit, Zone Read). Both in the password manager.
2. age on the server as the deploying user: `age-keygen -o ~/.config/sops/age/keys.txt` (mode 600), a copy in the password manager, the public key in `.sops.yaml`.
3. `sops infra/secrets/terraform.tfvars.json`: `root_domain`, `desk_emails`, `ops_emails`.
4. With `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the state token as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the shell: `infra/terraform/tf.sh init`, `plan`, `apply`. A second `plan` shows no changes.
5. By hand, two R2 tokens: one for `anr-raw` and `anr-media` (the apps'), one for `anr-backups` alone (pgBackRest's).
6. `sops infra/secrets/prod.env`: role passwords from `openssl rand -hex 32`, `ANR_PLATFORM_KEY` from `openssl rand -base64 32` (not dev's), `ANR_BACKUP_PASSPHRASE` from `openssl rand -base64 48`, both R2 tokens, `R2_ACCOUNT_ID`, `GEMINI_API_KEY`, `ANR_ROOT_DOMAIN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (`tf.sh output -raw desk_access_aud`), `CLOUDFLARE_TUNNEL_TOKEN` (`tf.sh output -raw tunnel_token`). The rest is filled in. Keep the platform key and the backup passphrase in the password manager too.
7. The host profile. Linux: Docker Engine with the Compose plugin, the repo at `/opt/anr`, Docker enabled at boot, `infra/host/linux/install.sh`. macOS: `sudo pmset -c sleep 0 disksleep 0`, Docker Desktop started at login, `infra/host/macos/install.sh`; the lid stays open, or closed only with an external display, and after a reboot someone must log in.
8. GitHub: install the Renovate app, push a `v*` tag, make the `anr-*` packages public.
9. `infra/deploy.sh --check`, then `infra/deploy.sh <tag>`, then `infra/backup/backup.sh full`.
10. Gate: `infra/backup/restore-drill.sh <tag>` on a fresh machine (age key and passphrase from the password manager), then `pnpm config:check` and config sync against it.
