// Desk sign-in: Cloudflare Access sits in front of desk.$ANR_ROOT_DOMAIN and adds a signed JWT to
// every request. The API trusts only that JWT, verified here, never a header it cannot check.
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const ACCESS_HEADER = "cf-access-jwt-assertion";

export interface AccessConfig {
  /** CF_ACCESS_TEAM_DOMAIN: `<team>` or `<team>.cloudflareaccess.com`. */
  teamDomain?: string;
  /** CF_ACCESS_AUD: the Access application's audience tag. */
  audience?: string;
  rootDomain: string;
  /** ANR_DESK_DEV_EMAIL: development only, on localhost with no Access settings (D95). */
  devEmail?: string;
  /** The team's signing keys; tests pass a local key set. */
  keys?: JWTVerifyGetKey;
}

/** Returns the signed-in email, or null. Never throws on a bad token. */
export type VerifyAccess = (token: string | undefined) => Promise<string | null>;

export function accessVerifier(config: AccessConfig): VerifyAccess {
  const { teamDomain, audience, rootDomain, devEmail } = config;
  if (!teamDomain && !audience) {
    if (devEmail && rootDomain === "localhost") return async () => devEmail;
    // Not configured: nobody signs in.
    return async () => null;
  }
  if (!teamDomain || !audience)
    throw new Error("set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither");
  const host = teamDomain.includes(".") ? teamDomain : `${teamDomain}.cloudflareaccess.com`;
  const issuer = `https://${host}`;
  const keys = config.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (token) => {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ["RS256"],
      });
      return typeof payload.email === "string" && payload.email.includes("@")
        ? payload.email.toLowerCase()
        : null;
    } catch {
      return null;
    }
  };
}
