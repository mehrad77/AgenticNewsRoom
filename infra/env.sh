# shellcheck shell=bash
# Sourced by deploy.sh and the restore scripts: loads the production env (D125) and exports its
# values and ANR_ENV_FILE (absolute, for Compose's env_file). ANR_ENV_FILE=<file> uses that
# plaintext file (the local drill); otherwise infra/secrets/prod.env is decrypted with the
# operator's age key into a private temporary directory that is removed when the script exits.

# The operator's age key where the docs put it (D125); on macOS sops would otherwise look in
# ~/Library/Application Support/sops/age.
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

# Every secret ANR reads, as listed in .env.example (D124); infra/check.ts keeps the two equal.
# shellcheck disable=SC2034
ANR_SECRETS=(
  ANR_PLATFORM_KEY POSTGRES_PASSWORD ANR_MIGRATOR_DB_PASSWORD ANR_APP_DB_PASSWORD
  ANR_SYSTEM_DB_PASSWORD R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BACKUP_ACCESS_KEY_ID
  R2_BACKUP_SECRET_ACCESS_KEY ANR_BACKUP_PASSPHRASE
  GEMINI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY MISTRAL_API_KEY NVIDIA_API_KEY
  CLOUDFLARE_TUNNEL_TOKEN ANR_OPS_TELEGRAM_BOT_TOKEN
)

load_prod_env() {
  # The file is the only source of settings: a variable left in the shell (a dev .env loaded by a
  # profile) would otherwise beat it in Compose's interpolation. The release to run stays.
  local name
  while read -r name; do
    case "$name" in ANR_IMAGES | ANR_VERSION) ;; *) unset "$name" ;; esac
  done < <(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env.example)
  if [[ -z "${ANR_ENV_FILE:-}" ]]; then
    command -v sops >/dev/null || { echo "sops is not installed (infra/AGENTS.md)" >&2; return 1; }
    ANR_ENV_DIR="$(mktemp -d)" || return 1
    trap 'rm -rf "$ANR_ENV_DIR"' EXIT
    (umask 077 && sops --decrypt --input-type dotenv --output-type dotenv infra/secrets/prod.env \
      >"$ANR_ENV_DIR/prod.env") || { echo "sops could not decrypt infra/secrets/prod.env" >&2; return 1; }
    ANR_ENV_FILE="$ANR_ENV_DIR/prod.env"
  fi
  [[ -f "$ANR_ENV_FILE" ]] || { echo "no $ANR_ENV_FILE" >&2; return 1; }
  ANR_ENV_FILE="$(cd "$(dirname "$ANR_ENV_FILE")" && pwd)/$(basename "$ANR_ENV_FILE")"
  export ANR_ENV_FILE
  # Read as data, never run as shell: a value is exported exactly as written (surrounding quotes
  # dropped, as Compose does), so nothing in a password or token can run or expand.
  local line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    export "$name=$value"
  done <"$ANR_ENV_FILE"
}
