import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  appleUserInfo,
  googleEmailVerified,
  isBuiltinAuthorizationURL,
  publicSignInProviders,
  socialAuthFromFields,
  socialTrustedOrigins,
} from "./social.js";
import { socialPresentation } from "./social-presentation.js";

const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();

const apple = {
  appleClientId: "com.example.service",
  appleTeamId: "TEAMID1234",
  appleKeyId: "KEYID12345",
  applePrivateKey: pem,
};

it("enables no social provider when nothing is set", () => {
  expect(socialAuthFromFields({})).toBeUndefined();
  expect(publicSignInProviders(undefined, undefined)).toEqual([]);
});

it("enables Google only when both credentials are set", () => {
  expect(() => socialAuthFromFields({ googleClientId: "client" })).toThrow(/configured together/);
  expect(() => socialAuthFromFields({ googleClientSecret: "secret" })).toThrow(
    /configured together/,
  );
  expect(
    socialAuthFromFields({ googleClientId: " client ", googleClientSecret: " secret " }),
  ).toEqual({
    providers: [{ id: "google", name: "Google", clientId: "client", clientSecret: "secret" }],
  });
});

it("enables Apple from the key material and refuses a partial set", () => {
  expect(() => socialAuthFromFields({ appleClientId: "com.example.service" })).toThrow(
    /configured together/,
  );
  expect(() =>
    socialAuthFromFields({
      ...apple,
      applePrivateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n",
    }),
  ).toThrow(/P-256|PKCS#8/);
  expect(socialAuthFromFields(apple)?.providers).toEqual([
    expect.objectContaining({
      id: "apple",
      name: "Apple",
      clientId: "com.example.service",
      teamId: "TEAMID1234",
      keyId: "KEYID12345",
    }),
  ]);
});

it("lists OpenID Connect ahead of the configured social providers, without secrets", () => {
  const social = socialAuthFromFields({
    ...apple,
    googleClientId: "google-client",
    googleClientSecret: "google-secret",
  });
  expect(publicSignInProviders(social, { name: "SSO" })).toEqual([
    { id: "oidc", name: "SSO" },
    { id: "google", name: "Google", presentation: socialPresentation("google") },
    { id: "apple", name: "Apple", presentation: socialPresentation("apple") },
  ]);
  expect(JSON.stringify(publicSignInProviders(social, undefined))).not.toContain("google-secret");
  expect(JSON.stringify(publicSignInProviders(social, undefined))).not.toContain("PRIVATE KEY");
});

it("recognizes only the enabled provider's authorization endpoint", () => {
  expect(
    isBuiltinAuthorizationURL(
      "google",
      "https://accounts.google.com/o/oauth2/v2/auth?state=1&client_id=x",
    ),
  ).toBe(true);
  expect(isBuiltinAuthorizationURL("google", "https://accounts.google.com/o/oauth2/v2/other")).toBe(
    false,
  );
  expect(
    isBuiltinAuthorizationURL("apple", "https://appleid.apple.com/auth/authorize?state=1"),
  ).toBe(true);
  expect(isBuiltinAuthorizationURL("apple", "https://attacker.example.test/auth/authorize")).toBe(
    false,
  );
  expect(isBuiltinAuthorizationURL("oidc", "https://appleid.apple.com/auth/authorize")).toBe(false);
});

it("fills a later Apple sign-in from the stored account when the token omits the email", async () => {
  const token = jwt({ sub: "subject-1" });
  const prisma = {
    account: {
      findFirst: async () => ({
        user: { email: "ada@example.test", emailVerified: true, name: "Ada" },
      }),
    },
  };
  await expect(appleUserInfo(prisma, { idToken: token })).resolves.toMatchObject({
    user: { email: "ada@example.test", emailVerified: true, name: "Ada" },
  });
  const withEmail = jwt({ sub: "subject-1", email: "new@example.test", email_verified: true });
  await expect(
    appleUserInfo(
      {
        account: {
          findFirst: async () => {
            throw new Error("should not look up");
          },
        },
      },
      { idToken: withEmail, user: { name: { firstName: "Ada", lastName: "Lovelace" } } },
    ),
  ).resolves.toMatchObject({
    user: { email: "new@example.test", emailVerified: false, name: "Ada Lovelace" },
  });
});

it("never treats client-supplied Apple email as a verified token claim", async () => {
  const result = await appleUserInfo(
    { account: { findFirst: async () => null } },
    {
      idToken: jwt({ sub: "new-subject", email_verified: true }),
      user: { email: "victim@example.test" },
    },
  );
  expect(result?.user.email).toBeUndefined();
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

it.each([
  ["user@icloud.com", true],
  ["user@me.com", true],
  ["user@mac.com", true],
  ["relay@privaterelay.appleid.com", true],
  ["relay@private.icloud.com", true],
  ["former@example.test", false],
  ["former@icloud.com.example.test", false],
])("requires Apple authority over mailbox %s", async (email, expected) => {
  const prisma = { account: { findFirst: async () => null } };
  const token = { idToken: jwt({ sub: "subject", email, email_verified: true }) };
  expect((await appleUserInfo(prisma, token))?.user.emailVerified).toBe(expected);
  expect((await appleUserInfo(prisma, token, true))?.user.emailVerified).toBe(true);
  expect(
    (
      await appleUserInfo(
        prisma,
        { idToken: jwt({ sub: "subject", email, email_verified: false }) },
        true,
      )
    )?.user.emailVerified,
  ).toBe(false);
});

it("requires Google authority over a verified mailbox", () => {
  expect(googleEmailVerified({ email: "user@example.test", email_verified: true })).toBe(false);
  expect(googleEmailVerified({ email: "user@gmail.com", email_verified: true })).toBe(true);
  expect(googleEmailVerified({ email: "user@googlemail.com", email_verified: true })).toBe(true);
  expect(googleEmailVerified({ email: "user@googlemail.com", email_verified: false })).toBe(false);
  expect(
    googleEmailVerified({ email: "user@googlemail.com.example.test", email_verified: true }),
  ).toBe(false);
  expect(
    googleEmailVerified({ email: "user@example.test", email_verified: true, hd: "example.test" }),
  ).toBe(true);
  expect(
    googleEmailVerified({ email: "user@other.test", email_verified: true, hd: "example.test" }),
  ).toBe(false);
  expect(googleEmailVerified({ email: "user@gmail.com", email_verified: false })).toBe(false);
});
it("trusts only the configured Apple POST callback origin", () => {
  const social = socialAuthFromFields({
    appleClientId: "service",
    appleTeamId: "team",
    appleKeyId: "key",
    applePrivateKey: pem,
  });
  for (const path of [
    "/api/auth/sign-in/social",
    "/api/auth/link-social",
    "/api/auth/callback/google",
  ]) {
    expect(
      socialTrustedOrigins(
        social,
        new Request(`https://app.example.test${path}`, { method: "POST" }),
      ),
    ).toEqual([]);
  }
  expect(
    socialTrustedOrigins(
      social,
      new Request("https://app.example.test/api/auth/callback/apple", { method: "POST" }),
    ),
  ).toEqual(["https://appleid.apple.com"]);
  expect(
    socialTrustedOrigins(
      undefined,
      new Request("https://app.example.test/api/auth/callback/apple", { method: "POST" }),
    ),
  ).toEqual([]);
});
