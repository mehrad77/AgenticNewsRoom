#!/usr/bin/env bash
# Deploys the production stack on the VM, from the repo root: checks .env, builds, applies role
# passwords, checks backups, then starts everything (migrate and config-sync finish first).
#   infra/deploy.sh --check    only check .env
set -euo pipefail
cd "$(dirname "$0")/.."

die() {
  echo "deploy: $*" >&2
  exit 1
}
env_file="${ANR_ENV_FILE:-.env}"
[[ -f "$env_file" ]] || die "no $env_file; copy .env.example and fill in production values (infra/AGENTS.md)"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

problems=()
for name in ANR_ROOT_DOMAIN ANR_PLATFORM_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY \
  ANR_BACKUP_BUCKET ANR_BACKUP_PASSPHRASE CLOUDFLARE_DNS_API_TOKEN; do
  [[ -n "${!name:-}" ]] || problems+=("$name is not set")
done
# Hex keeps the passwords valid inside database URLs; 64 characters is 256 bits.
for name in POSTGRES_PASSWORD ANR_MIGRATOR_DB_PASSWORD ANR_APP_DB_PASSWORD ANR_SYSTEM_DB_PASSWORD; do
  [[ "${!name:-}" =~ ^[0-9a-f]{64}$ ]] || problems+=("$name must be 64 hex characters (openssl rand -hex 32)")
done
key_bytes=$(printf %s "${ANR_PLATFORM_KEY:-}" | base64 --decode 2>/dev/null | wc -c | tr -d ' ')
[[ "$key_bytes" == 32 ]] || problems+=("ANR_PLATFORM_KEY must be 32 bytes, base64 (openssl rand -base64 32)")
passphrase="${ANR_BACKUP_PASSPHRASE:-}"
[[ "${#passphrase}" -ge 32 ]] || problems+=("ANR_BACKUP_PASSPHRASE must be at least 32 characters")
[[ "${ANR_WAL_ARCHIVE:-}" == on ]] || problems+=("ANR_WAL_ARCHIVE must be on")
[[ "${ANR_DATABASES:-}" == anr ]] || problems+=("ANR_DATABASES must be anr (no test database in production)")
[[ "${ANR_ROOT_DOMAIN:-}" != localhost ]] || problems+=("ANR_ROOT_DOMAIN is still localhost")
if ((${#problems[@]} > 0)); then
  printf 'deploy: %s\n' "${problems[@]}" >&2
  exit 1
fi
for name in GEMINI_API_KEY CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD; do
  [[ -n "${!name:-}" ]] || echo "deploy: warning: $name is not set (needed from milestones 3 and 4)"
done
if [[ "${1:-}" == --check ]]; then
  echo "deploy: $env_file is ready for production"
  exit 0
fi

compose() { docker compose --env-file "$env_file" -f infra/compose.yaml --profile prod "$@"; }
compose build
compose up -d --wait postgres
# Role passwords from .env: creates the roles on a new volume, rotates them on an existing one.
compose exec -T postgres anr-roles
# Creates the backup stanza if needed and fails the deploy if WAL archiving to R2 is broken.
COMPOSE_ENV_FILES="$env_file" infra/backup/backup.sh init
compose up -d --remove-orphans
compose ps
