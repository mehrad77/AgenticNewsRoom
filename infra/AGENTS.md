# infra

One VM (Hetzner Cloud, 4 dedicated vCPU / 16 GB) runs everything with Docker Compose. Postgres holds data and the pg-boss queue; R2 holds audio, raw source snapshots and pgBackRest backups.

- `compose.yaml`: Postgres for dev; the `prod` profile adds the apps, the Python services and Caddy.
- `Caddyfile`: wildcard TLS via Cloudflare DNS-01; only `web` and `api` are public.
- `postgres/init.sql`: dev-only roles (`anr_migrator`, `anr_app`, `anr_system`) and `pg_trgm`.
- pgBackRest, the restore drill and the production role bootstrap are milestone 1 tasks (`docs/build-plan.md`).
