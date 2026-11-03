#!/usr/bin/env bash
# Entrypoint of the lgtm container: sets Grafana's sign-in, then runs otel-lgtm's own run-all.sh.
# Production signs people in from the Cloudflare Access JWT alone, checking the ops application's
# audience (D123); it refuses to start without one rather than fall back to anything weaker. Dev
# sets ANR_GRAFANA_ANONYMOUS=Viewer instead: read-only, on loopback.
set -euo pipefail

# No password and no form: the only way in is the Access JWT (or dev's anonymous viewer).
export GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true
export GF_AUTH_DISABLE_LOGIN_FORM=true
export GF_AUTH_BASIC_ENABLED=false
export GF_USERS_ALLOW_SIGN_UP=false
# Nothing leaves for Grafana's own services: no plugin downloads, update checks, news or gravatar
# (a hash of the operator's email).
export GF_PLUGINS_PREINSTALL_DISABLED=true
export GF_ANALYTICS_REPORTING_ENABLED=false
export GF_ANALYTICS_CHECK_FOR_UPDATES=false
export GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false
export GF_NEWS_NEWS_FEED_ENABLED=false
export GF_SECURITY_DISABLE_GRAVATAR=true
# No snapshots to Grafana's servers and no public dashboards: nothing is shown without sign-in.
export GF_SNAPSHOTS_EXTERNAL_ENABLED=false
export GF_PUBLIC_DASHBOARDS_ENABLED=false
# Encrypts what Grafana stores (the Telegram token of the contact point): made once, kept on
# Grafana's own volume, never the image's public default.
key=/data/grafana/secret_key
mkdir -p /data/grafana
[[ -s "$key" ]] || (umask 077 && head -c 32 /dev/urandom | base64 >"$key")
GF_SECURITY_SECRET_KEY="$(cat "$key")"
export GF_SECURITY_SECRET_KEY

# Alerts reach the ops chat only where its bot and chat are set (production, which deploy.sh
# checks). Dev, the sign-in check and a trial stack keep Grafana's default contact point, an email
# without a mail server: alerts show in Grafana and nothing is sent.
provisioning=/tmp/anr-provisioning
rm -rf "$provisioning"
cp -R /etc/anr/grafana/provisioning "$provisioning"
if [[ -n "${ANR_OPS_TELEGRAM_BOT_TOKEN:-}" && -n "${ANR_OPS_TELEGRAM_CHAT_ID:-}" ]]; then
  cp /etc/anr/grafana/telegram/ops-chat.yaml "$provisioning/alerting/"
fi
export GF_PATHS_PROVISIONING="$provisioning"

if [[ -n "${ANR_GRAFANA_ANONYMOUS:-}" ]]; then
  [[ "$ANR_GRAFANA_ANONYMOUS" == Viewer ]] || { echo "ANR_GRAFANA_ANONYMOUS may only be Viewer" >&2; exit 1; }
  export GF_AUTH_ANONYMOUS_ENABLED=true GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
else
  : "${CF_ACCESS_TEAM_DOMAIN:?Grafana signs in through Access: set CF_ACCESS_TEAM_DOMAIN}"
  : "${CF_ACCESS_OPS_AUD:?Grafana signs in through Access: set CF_ACCESS_OPS_AUD}"
  host="$CF_ACCESS_TEAM_DOMAIN"
  [[ "$host" == *.* ]] || host="$host.cloudflareaccess.com"
  export GF_AUTH_ANONYMOUS_ENABLED=false
  # No password sign-in at all, not only no form; cookies only over HTTPS (Cloudflare's).
  export GF_AUTH_DISABLE_LOGIN=true
  export GF_SECURITY_COOKIE_SECURE=true
  export GF_AUTH_JWT_ENABLED=true
  export GF_AUTH_JWT_HEADER_NAME=Cf-Access-Jwt-Assertion
  export GF_AUTH_JWT_EMAIL_CLAIM=email
  export GF_AUTH_JWT_USERNAME_CLAIM=email
  if [[ -n "${ANR_GRAFANA_JWK_SET_FILE:-}" ]]; then
    # The sign-in test (infra/observability/check-grafana-auth.sh) signs with its own key.
    export GF_AUTH_JWT_JWK_SET_FILE="$ANR_GRAFANA_JWK_SET_FILE"
  else
    export GF_AUTH_JWT_JWK_SET_URL="https://$host/cdn-cgi/access/certs"
  fi
  export GF_AUTH_JWT_EXPECT_CLAIMS="{\"aud\":[\"$CF_ACCESS_OPS_AUD\"],\"iss\":\"https://$host\"}"
  export GF_AUTH_JWT_AUTO_SIGN_UP=true
  export GF_AUTH_JWT_URL_LOGIN=false
  # Access lets only the operator through (D123), so whoever has a valid token is the operator:
  # an Editor, to silence alerts; provisioned dashboards and rules stay read-only (D139).
  export GF_AUTH_JWT_ROLE_ATTRIBUTE_PATH="'Editor'"
  export GF_AUTH_JWT_ROLE_ATTRIBUTE_STRICT=true
  export GF_AUTH_JWT_ALLOW_ASSIGN_GRAFANA_ADMIN=false
fi

exec /otel-lgtm/run-all.sh
