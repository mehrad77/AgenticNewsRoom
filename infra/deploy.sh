#!/usr/bin/env bash
# Deploys a release on the server, from the repo root of its checkout (D134):
#   infra/deploy.sh <tag>      pull the tag's images and start anr-prod
#   infra/deploy.sh --check    check the production env and the host only
#   infra/deploy.sh --promote-restore <tag>
#                              make a restored database production (only when this machine
#                              replaces the old server): its WAL then archives to the repository
# The env is infra/secrets/prod.env, decrypted for the length of the run (D125, infra/env.sh). The
# server never builds: images come from GHCR, so rolling back is deploying an older tag. Compose
# file, Caddyfile and scripts are this checkout's; pull main before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=env.sh
source infra/env.sh

die() {
  echo "deploy: $*" >&2
  exit 1
}
promote=0
if [[ "${1:-}" == --promote-restore ]]; then
  promote=1
  shift
fi
case "${1:-}" in
  --check) tag="" ;;
  "" | -*) die "usage: infra/deploy.sh [--promote-restore] <tag> | --check" ;;
  *) tag="$1" ;;
esac
load_prod_env || die "could not load the production env"

problems=()
warnings=()
# Settings and secrets production cannot run without (D124). Model keys other than the models
# file's are optional.
for name in ANR_ROOT_DOMAIN CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD ANR_PLATFORM_KEY R2_ACCOUNT_ID \
  R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY \
  ANR_BACKUP_BUCKET ANR_RAW_BUCKET ANR_MEDIA_BUCKET ANR_BACKUP_PASSPHRASE GEMINI_API_KEY \
  CLOUDFLARE_TUNNEL_TOKEN; do
  [[ -n "${!name:-}" ]] || problems+=("$name is not set")
done
# Hex keeps the passwords valid inside database URLs; 64 characters is 256 bits.
for name in POSTGRES_PASSWORD ANR_MIGRATOR_DB_PASSWORD ANR_APP_DB_PASSWORD ANR_SYSTEM_DB_PASSWORD; do
  [[ "${!name:-}" =~ ^[0-9a-f]{64}$ ]] || problems+=("$name must be 64 hex characters (openssl rand -hex 32)")
done
key_bytes=$({ printf %s "${ANR_PLATFORM_KEY:-}" | base64 --decode 2>/dev/null || true; } | wc -c | tr -d ' ')
[[ "$key_bytes" == 32 ]] || problems+=("ANR_PLATFORM_KEY must be 32 bytes, base64 (openssl rand -base64 32)")
# Base64 only, so Compose passes it to pgBackRest exactly as the password manager holds it.
[[ "${ANR_BACKUP_PASSPHRASE:-}" =~ ^[A-Za-z0-9+/=]{48,}$ ]] ||
  problems+=("ANR_BACKUP_PASSPHRASE must be base64, at least 48 characters (openssl rand -base64 48)")
[[ "${ANR_WAL_ARCHIVE:-}" == on ]] || problems+=("ANR_WAL_ARCHIVE must be on")
[[ "${ANR_DATABASES:-}" == anr ]] || problems+=("ANR_DATABASES must be anr (no test database in production)")
[[ "${ANR_ROOT_DOMAIN:-}" != localhost ]] || problems+=("ANR_ROOT_DOMAIN is still localhost")
# Only prod sends to real channels (D126).
[[ "${ANR_PUBLISH:-}" == live ]] || problems+=("ANR_PUBLISH must be live")
# Free tiers may train on prompts and have no availability promise (D72).
[[ "${ANR_MODELS:-}" != free ]] || problems+=("ANR_MODELS=free is for development only")
[[ "${ANR_TTS:-}" != fake ]] || problems+=("ANR_TTS=fake is for dry runs only")
# The desk's development sign-in skips Cloudflare Access (D95).
[[ -z "${ANR_DESK_DEV_EMAIL:-}" ]] || problems+=("ANR_DESK_DEV_EMAIL is for development only")
[[ -z "${CLOUDFLARE_DNS_API_TOKEN:-}" ]] || warnings+=("CLOUDFLARE_DNS_API_TOKEN is no longer used (D124); remove it")
[[ -n "${ANR_OPS_TELEGRAM_BOT_TOKEN:-}" && -n "${ANR_OPS_TELEGRAM_CHAT_ID:-}" ]] ||
  warnings+=("ANR_OPS_TELEGRAM_BOT_TOKEN and ANR_OPS_TELEGRAM_CHAT_ID are not set (alerts, milestone 7b)")

# The host (D127, D132).
docker info >/dev/null 2>&1 || die "Docker is not running"
percent_free() { awk 'NR == 2 { printf "%d", $4 * 100 / ($3 + $4) }'; }
# The disk Docker's volumes live on, seen from a container: the host's on Linux, the VM's on macOS.
probe=$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' infra/compose.prod.yaml)
free=$(docker run --rm --network none --entrypoint df "$probe" -P / | percent_free)
((free >= 10)) || problems+=("Docker's disk has ${free}% free; at least 10% is needed (D132)")
if [[ "$(uname -s)" == Darwin ]]; then
  # Docker's VM disk is a file on the Mac's own disk.
  free=$(df -P "$HOME" | percent_free)
  ((free >= 10)) || problems+=("the Mac's disk has ${free}% free; at least 10% is needed (D132)")
  ac_sleep=$(pmset -g custom | awk '/^AC Power/ { ac = 1 } /^Battery Power/ { ac = 0 } ac && $1 == "sleep" { print $2 }')
  [[ "${ac_sleep:-0}" == 0 ]] ||
    warnings+=("sleep is on for AC power ($ac_sleep min): sudo pmset -c sleep 0 disksleep 0 (D127)")
fi
# A restored copy archives nothing until a person says it is production now (restore.sh marks it).
postgres=$(docker ps -q --filter label=com.docker.compose.project=anr-prod \
  --filter label=com.docker.compose.service=postgres)
restored=""
if [[ -n "$postgres" ]]; then
  restored=$(docker exec "$postgres" psql -U postgres -d anr -tAc \
    "select value from platform_settings where key = 'restore.unpromoted'" 2>/dev/null || true)
fi
[[ "$restored" != true || "$promote" == 1 ]] ||
  problems+=("this database is a restored copy: deploying turns WAL archiving on into the production repository. Only if this machine replaces production: --promote-restore")
port="${ANR_PG_PORT:-5433}"
taken=$(docker ps --filter "publish=$port" --format '{{.Label "com.docker.compose.project"}}' | grep -vx anr-prod || true)
[[ -z "$taken" ]] || problems+=("port $port is published by project ${taken//$'\n'/, }; set ANR_PG_PORT in prod.env")

if ((${#problems[@]} > 0)); then
  printf 'deploy: %s\n' "${problems[@]}" >&2
  exit 1
fi
((${#warnings[@]} == 0)) || printf 'deploy: warning: %s\n' "${warnings[@]}"
if [[ -z "$tag" ]]; then
  echo "deploy: the production env and this host are ready"
  exit 0
fi

export ANR_VERSION="$tag"
# -p as well as the file's name: an exported COMPOSE_PROJECT_NAME would otherwise win.
compose() { docker compose -p anr-prod --env-file "$ANR_ENV_FILE" -f infra/compose.prod.yaml "$@"; }
compose pull --quiet
compose up -d --wait postgres
# Role passwords from the env: creates the roles on a new volume, rotates them on an existing one.
compose exec -T postgres anr-roles
if [[ "$restored" == true ]]; then
  compose exec -T postgres psql -U postgres -d anr -c "delete from platform_settings where key = 'restore.unpromoted'"
fi
# Creates the backup stanza if needed and fails the deploy if WAL archiving to R2 is broken.
infra/backup/backup.sh init
compose up -d --remove-orphans
# /healthz answers 200 once Postgres answers and every worker has beaten (D128).
for _ in $(seq 1 40); do
  if compose exec -T caddy wget -q -O /dev/null http://web:4321/healthz 2>/dev/null; then
    compose ps
    echo "deploy: $tag is up"
    exit 0
  fi
  sleep 3
done
compose ps
die "$tag started, but /healthz did not answer 200 within 2 minutes (docker compose -p anr-prod logs)"
