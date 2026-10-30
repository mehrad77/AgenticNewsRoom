terraform {
  # 1.10 added the S3 backend's lockfile; CI pins the exact version.
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # State in a private R2 bucket made by hand (D136); a backend cannot create its own bucket. The
  # endpoint comes from AWS_ENDPOINT_URL_S3 and the bucket's token from AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY, which tf.sh and the operator's shell provide.
  backend "s3" {
    bucket = "anr-terraform-state"
    key    = "cloudflare.tfstate"
    region = "auto"
    # A lock object written with If-None-Match: *, which R2 evaluates atomically.
    use_lockfile   = true
    use_path_style = true
    # R2 is not AWS: no STS, no regions, no instance metadata, no flexible checksums.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}

# Authenticates with CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
