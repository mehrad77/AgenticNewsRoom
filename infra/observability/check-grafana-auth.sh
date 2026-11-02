#!/usr/bin/env bash
# Grafana's sign-in as production runs it (D123, D156), in a throwaway container with a key of its
# own instead of Cloudflare's: a request without the Access JWT, with another application's, with
# a password or by basic auth is refused; the ops application's token signs in as Editor; a
# provisioned dashboard cannot be saved. Needs Docker and Node; touches no other container.
#   infra/observability/check-grafana-auth.sh
set -euo pipefail
cd "$(dirname "$0")"
image=$(sed -n 's/^ *image: \(grafana\/otel-lgtm:[^ ]*\)$/\1/p' ../compose.prod.yaml | head -1)
name=anr-grafana-auth-check
work=$(mktemp -d)
# KEEP=1 leaves the container for its log.
trap '[[ -n "${KEEP:-}" ]] || { docker rm -f "$name" >/dev/null 2>&1; rm -rf "$work"; }' EXIT
team=anr-check.cloudflareaccess.com
aud=ops-audience-check

# A key pair, its JWKS for Grafana, and tokens shaped like Access's: aud is an array, and sub is
# set (Grafana refuses a token without one, without a log line).
node --input-type=module - "$work" "$team" "$aud" <<'EOF'
import { createSign, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const [dir, team, aud] = process.argv.slice(2);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "check", alg: "RS256", use: "sig" };
writeFileSync(`${dir}/jwks.json`, JSON.stringify({ keys: [jwk] }));
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const token = (audience) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", kid: "check" })}.${b64({ aud: [audience], iss: `https://${team}`, sub: "00000000-0000-4000-8000-000000000001", email: "operator@check.invalid", iat: now, exp: now + 600 })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
};
writeFileSync(`${dir}/ops.jwt`, token(aud));
writeFileSync(`${dir}/desk.jwt`, token("desk-audience"));
EOF
chmod 644 "$work"/jwks.json

docker run -d --name "$name" -p 127.0.0.1::3000 \
  -e CF_ACCESS_TEAM_DOMAIN="$team" -e CF_ACCESS_OPS_AUD="$aud" \
  -e ANR_GRAFANA_JWK_SET_FILE=/etc/anr/jwks.json -e GF_SECURITY_COOKIE_SECURE=false \
  -e ENABLE_LOGS_GRAFANA="${KEEP:+true}" -e GF_LOG_LEVEL="${KEEP:+debug}" \
  -v "$work/jwks.json:/etc/anr/jwks.json:ro" \
  -v "$PWD/grafana/start.sh:/etc/anr/grafana/start.sh:ro" \
  -v "$PWD/grafana/provisioning:/etc/anr/grafana/provisioning:ro" \
  -v "$PWD/grafana/dashboards:/etc/anr/grafana/dashboards:ro" \
  --entrypoint /etc/anr/grafana/start.sh "$image" >/dev/null
port=$(docker port "$name" 3000/tcp | head -1 | sed 's/.*://')
url="http://127.0.0.1:$port"
for _ in $(seq 1 90); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url/api/health")" == 200 ]] && break
  sleep 2
done

failed=0
expect() { # <status> <description> <curl args...>
  local want=$1 what=$2 got
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [[ "$got" == "$want" ]]; then echo "✓ $what ($got)"; else echo "✗ $what: $got, expected $want"; failed=1; fi
}
jwt() { echo "Cf-Access-Jwt-Assertion: $(cat "$work/$1.jwt")"; }
expect 401 "no Access JWT is refused" "$url/api/user"
expect 401 "the desk application's JWT is refused" -H "$(jwt desk)" "$url/api/user"
expect 401 "basic auth is refused" -u admin:admin "$url/api/user"
login=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"user":"admin","password":"admin"}' "$url/login")
# 400: the password client is not configured at all.
if [[ "$login" =~ ^(400|401|403|404)$ ]]; then echo "✓ password sign-in is refused ($login)"; else echo "✗ password sign-in answered $login"; failed=1; fi
expect 200 "the ops application's JWT signs in" -H "$(jwt ops)" "$url/api/user"
role=$(curl -s -H "$(jwt ops)" "$url/api/user/orgs" | sed -n 's/.*"role":"\([A-Za-z]*\)".*/\1/p')
if [[ "$role" == Editor ]]; then echo "✓ the operator is an Editor"; else echo "✗ the operator's role is '$role'"; failed=1; fi

# Every provisioned dashboard refuses a save from the UI's API.
for file in grafana/dashboards/*.json; do
  [[ -e "$file" ]] || continue
  body=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));d.title+=" (edited)";process.stdout.write(JSON.stringify({dashboard:d,overwrite:true}))' "$file")
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$(jwt ops)" -H 'content-type: application/json' -d "$body" "$url/api/dashboards/db")
  if [[ "$status" =~ ^4 ]]; then echo "✓ $(basename "$file") cannot be saved ($status)"; else echo "✗ $(basename "$file") was saved ($status)"; failed=1; fi
done
exit "$failed"
