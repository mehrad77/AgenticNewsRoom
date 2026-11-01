# tflint in CI (D136): Terraform's own rules; there is no Cloudflare ruleset.
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
