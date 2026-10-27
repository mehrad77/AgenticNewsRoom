import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { accessVerifier } from "./access.ts";

const team = "anr-test.cloudflareaccess.com";
const aud = "aud-tag";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" }],
});

const token = (
  o: {
    iss?: string;
    aud?: string;
    exp?: string;
    email?: unknown;
    key?: Parameters<SignJWT["sign"]>[0];
  } = {},
) =>
  new SignJWT({ email: o.email ?? "Editor@Example.org" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? `https://${team}`)
    .setAudience(o.aud ?? aud)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.key ?? privateKey);

describe("Cloudflare Access verification", () => {
  const verify = accessVerifier({
    teamDomain: "anr-test",
    audience: aud,
    rootDomain: "example.org",
    keys,
  });

  it("accepts a token signed by the team for this application", async () => {
    expect(await verify(await token())).toBe("editor@example.org");
  });

  it("refuses a missing, forged, expired, foreign or wrong-audience token", async () => {
    expect(await verify(undefined)).toBeNull();
    expect(await verify("not.a.jwt")).toBeNull();
    expect(await verify(await token({ key: other.privateKey }))).toBeNull();
    expect(await verify(await token({ exp: "-1m" }))).toBeNull();
    expect(await verify(await token({ iss: "https://evil.cloudflareaccess.com" }))).toBeNull();
    expect(await verify(await token({ aud: "another-app" }))).toBeNull();
    expect(await verify(await token({ email: 42 }))).toBeNull();
  });

  it("allows the development email only on localhost without Access settings", async () => {
    expect(
      await accessVerifier({ rootDomain: "localhost", devEmail: "dev@x.test" })(undefined),
    ).toBe("dev@x.test");
    expect(
      await accessVerifier({ rootDomain: "example.org", devEmail: "dev@x.test" })(undefined),
    ).toBeNull();
    const configured = accessVerifier({
      teamDomain: "anr-test",
      audience: aud,
      rootDomain: "localhost",
      devEmail: "dev@x.test",
      keys,
    });
    expect(await configured(undefined)).toBeNull();
  });

  it("refuses half a configuration", () => {
    expect(() => accessVerifier({ teamDomain: "anr-test", rootDomain: "example.org" })).toThrow(
      /both/,
    );
  });
});
