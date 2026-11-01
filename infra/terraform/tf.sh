#!/usr/bin/env bash
# Terraform for Cloudflare (D136, D148), run by the operator from anywhere in the repo:
#   infra/terraform/tf.sh init | plan | apply | output -raw tunnel_token | <any terraform command>
# Needs, from the password manager into the shell (never a file in the repo):
#   CLOUDFLARE_API_TOKEN                       Terraform's Cloudflare token
#   CLOUDFLARE_ACCOUNT_ID                      the account id (not a secret)
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   the R2 token scoped to the state bucket
# Commands that read variables decrypt infra/secrets/terraform.tfvars.json for that one command
# (`sops exec-file`, a private temporary file removed when it ends). A saved plan carries state,
# tunnel token included: this directory's .gitignore keeps any plan file out of the repository.
set -euo pipefail
cd "$(dirname "$0")"

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (infra/AGENTS.md)}"
export TF_VAR_account_id="$CLOUDFLARE_ACCOUNT_ID"
# The S3 backend's endpoint: the state bucket on R2.
export AWS_ENDPOINT_URL_S3="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

# The operator's age key where the docs put it; on macOS sops would otherwise look elsewhere.
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

subcommand="${1:-}"
# Applying a saved plan takes no variables: they are in the plan.
if [[ "$subcommand" == apply && -f "${2:-}" ]]; then exec terraform "$@"; fi
case "$subcommand" in
  plan | apply | destroy | import | refresh | console)
    # The variable file goes right after the subcommand, before any positional argument; sops runs
    # the command through a shell, so each argument is quoted for it.
    rest=""
    if (($# > 1)); then printf -v rest '%q ' "${@:2}"; fi
    # Terraform tells JSON variable files by their extension; --no-fifo, since it may read one twice.
    exec sops exec-file --no-fifo --filename terraform.tfvars.json ../secrets/terraform.tfvars.json \
      "terraform $subcommand -var-file={} ${rest}"
    ;;
  *) exec terraform "$@" ;;
esac
