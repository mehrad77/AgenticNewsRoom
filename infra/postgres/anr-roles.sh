#!/usr/bin/env bash
# Creates or updates the platform roles and databases from environment passwords.
# Runs inside the postgres container: on first start (initdb/00-roles.sh), and by hand to rotate
# passwords: docker compose -f infra/compose.yaml exec postgres anr-roles
set -euo pipefail

for var in ANR_MIGRATOR_DB_PASSWORD ANR_APP_DB_PASSWORD ANR_SYSTEM_DB_PASSWORD ANR_DATABASES; do
  if [[ -z "${!var:-}" ]]; then
    echo "anr-roles: $var is not set" >&2
    exit 1
  fi
done

psql_super=(psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}")

"${psql_super[@]}" --dbname postgres \
  -v migrator_password="$ANR_MIGRATOR_DB_PASSWORD" \
  -v app_password="$ANR_APP_DB_PASSWORD" \
  -v system_password="$ANR_SYSTEM_DB_PASSWORD" \
  -v databases="$ANR_DATABASES" \
  -f /anr/roles.sql

# Per database: extensions need a superuser; the schema grants let the app roles see tables.
for db in $ANR_DATABASES; do
  "${psql_super[@]}" --dbname "$db" <<'SQL'
create extension if not exists pg_trgm;
grant usage on schema public to anr_app, anr_system;
SQL
done
echo "anr-roles: roles and databases ($ANR_DATABASES) are up to date"
