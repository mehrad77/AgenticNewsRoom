# Values come from infra/secrets/terraform.tfvars.json (SOPS-encrypted, read by tf.sh), except
# account_id, which tf.sh takes from CLOUDFLARE_ACCOUNT_ID.

variable "account_id" {
  description = "The Cloudflare account that holds the zone, Zero Trust and R2."
  type        = string
}

variable "root_domain" {
  description = "ANR_ROOT_DOMAIN: newsrooms at <subdomain>.<root>, the desk at desk.<root>, Grafana at ops.<root>."
  type        = string
}

variable "desk_emails" {
  description = "Who may open the desk (D123): every editor and the platform admin."
  type        = list(string)
  sensitive   = true
  validation {
    condition     = length(var.desk_emails) > 0
    error_message = "The desk needs at least one email."
  }
}

variable "ops_emails" {
  description = "Who may open Grafana at ops.: the operator alone, since it shows every newsroom (D123)."
  type        = list(string)
  sensitive   = true
  validation {
    condition     = length(var.ops_emails) > 0
    error_message = "ops. needs at least one email."
  }
}

variable "r2_location" {
  description = "Location hint for new R2 buckets (apac, eeur, enam, weur, wnam, oc); null lets R2 choose."
  type        = string
  default     = null
}
