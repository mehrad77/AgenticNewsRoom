# Private buckets (D132): no public access and no custom domain; the site serves audio and images
# through presigned URLs. Their API token is made by hand (D136), not here.
locals {
  buckets = {
    backups = "anr-backups" # pgBackRest: WAL and full and differential backups (D51)
    raw     = "anr-raw"     # raw pages as fetched (D55)
    media   = "anr-media"   # episode audio, published images and the TTS cache (D109, D120)
  }
}

resource "cloudflare_r2_bucket" "anr" {
  for_each = local.buckets

  account_id = var.account_id
  name       = each.value
  location   = var.r2_location

  # Deleting a bucket loses the backups or every published file: refuse it in any plan.
  lifecycle {
    prevent_destroy = true
  }
}
