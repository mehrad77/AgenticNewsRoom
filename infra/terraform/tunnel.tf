# Reachability (D122): one tunnel, outbound only from the server's cloudflared container. Its
# ingress is managed here (config_src = "cloudflare"), so cloudflared needs only its token.
resource "cloudflare_zero_trust_tunnel_cloudflared" "anr" {
  account_id = var.account_id
  name       = "anr"
  config_src = "cloudflare"

  # A new tunnel means a new token: the site is down until prod.env has it. Never by accident.
  lifecycle {
    prevent_destroy = true
  }
}

# One rule: every host the DNS records send here goes to Caddy over plain HTTP inside the Compose
# network; Caddy routes by host (infra/Caddyfile).
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "anr" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.anr.id
  config = {
    ingress = [{ service = "http://caddy:80" }]
  }
}

# The connector token for CLOUDFLARE_TUNNEL_TOKEN. It is in the state, which is why the state is a
# secret (D136).
data "cloudflare_zero_trust_tunnel_cloudflared_token" "anr" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.anr.id
}

data "cloudflare_zone" "root" {
  filter = { name = var.root_domain }
}

# The root and a wildcard, both proxied: a new newsroom's subdomain needs no record (D122).
# Universal SSL covers the root and one level of subdomains.
resource "cloudflare_dns_record" "tunnel" {
  for_each = toset([var.root_domain, "*.${var.root_domain}"])

  zone_id = data.cloudflare_zone.root.zone_id
  name    = each.value
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.anr.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic, as for every proxied record
  comment = "ANR: Cloudflare Tunnel (infra/terraform)"
}
