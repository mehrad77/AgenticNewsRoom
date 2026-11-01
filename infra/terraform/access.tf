# Cloudflare Access in front of the desk and Grafana (D123). Reader sites and /healthz stay
# outside it. The apps check the same JWT again at the origin: the desk with CF_ACCESS_AUD, Grafana
# with the ops application's audience (milestone 7b).

resource "cloudflare_zero_trust_access_policy" "desk" {
  account_id = var.account_id
  name       = "ANR desk: editors"
  decision   = "allow"
  include    = [for email in var.desk_emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_policy" "ops" {
  account_id = var.account_id
  name       = "ANR ops: operator"
  decision   = "allow"
  include    = [for email in var.ops_emails : { email = { email = email } }]
}

locals {
  access_apps = {
    desk = { name = "ANR desk", policy = cloudflare_zero_trust_access_policy.desk.id }
    ops  = { name = "ANR ops (Grafana)", policy = cloudflare_zero_trust_access_policy.ops.id }
  }
}

resource "cloudflare_zero_trust_access_application" "app" {
  for_each = local.access_apps

  account_id       = var.account_id
  type             = "self_hosted"
  name             = each.value.name
  destinations     = [{ type = "public", uri = "${each.key}.${var.root_domain}" }]
  session_duration = "24h"
  policies         = [{ id = each.value.policy, precedence = 1 }]
}
