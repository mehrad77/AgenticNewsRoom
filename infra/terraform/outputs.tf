# Values for infra/secrets/prod.env, read with `infra/terraform/tf.sh output -raw <name>`.

output "tunnel_token" {
  description = "CLOUDFLARE_TUNNEL_TOKEN"
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.anr.token
  sensitive   = true
}

output "desk_access_aud" {
  description = "CF_ACCESS_AUD: the desk application's audience tag"
  value       = cloudflare_zero_trust_access_application.app["desk"].aud
}

output "ops_access_aud" {
  description = "The ops application's audience tag, for Grafana's JWT sign-in (milestone 7b)"
  value       = cloudflare_zero_trust_access_application.app["ops"].aud
}

output "buckets" {
  description = "ANR_BACKUP_BUCKET, ANR_RAW_BUCKET and ANR_MEDIA_BUCKET"
  value       = { for key, bucket in cloudflare_r2_bucket.anr : key => bucket.name }
}
