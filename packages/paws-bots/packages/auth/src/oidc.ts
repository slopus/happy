import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import type { TokenKey } from "./token-storage.js";
import { openIdToken } from "./token-storage.js";

const OIDC_FRESH_AGE = 5 * 60;
const OIDC_CLOCK_SKEW = 60;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  allowSignupBypass: boolean;
}

/** Discovery never gates API startup. Failed attempts share exponential backoff. */
export function oidcDiscovery(config: OidcConfig) {
  const generic = genericOAuth({
    config: [
      {
        providerId: "oidc",
        name: config.name,
        discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: [...new Set(["openid", "email", "profile", ...config.scopes])],
        pkce: true,
        accountSubject: ({ profile }) => {
          if (typeof profile.sub !== "string" || !profile.sub.trim()) return "";
          // Subjects are unique within an issuer, never across different IdPs.
          return oidcAccountSubject(config.issuer, profile.sub);
        },
        requireIdTokenVerification: true,
        mapProfileToUser: (profile) => ({ emailVerified: profile.email_verified === true }),
      },
    ],
  });
  type Provider = Awaited<ReturnType<typeof generic.init>>["context"]["socialProviders"][number];
  let provider: Provider | undefined;
  let pending: Promise<Provider> | undefined;
  let nextAttempt = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let availability: "checking" | "available" | "unavailable" = "checking";
  let resolveProvider: (() => Promise<Provider>) | undefined;
  const unavailable = () =>
    new APIError("SERVICE_UNAVAILABLE", {
      code: "SSO_UNAVAILABLE",
      message: "SSO is temporarily unavailable. Try again.",
    });
  const plugin: BetterAuthPlugin = {
    id: "oidc-discovery",
    init(ctx) {
      const schedule = (delay: number) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void discover().catch(() => undefined);
        }, delay);
        timer.unref?.();
      };
      const discover = (): Promise<Provider> => {
        if (pending) return pending;
        if (Date.now() < nextAttempt) return Promise.reject(unavailable());
        pending = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              // The library may log upstream error detail. Keep discovery errors generic.
              generic.init({
                ...ctx,
                socialProviders: ctx.socialProviders.filter((item) => item.id !== "oidc"),
                logger: { ...ctx.logger, error: () => undefined },
              }),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(unavailable()), 8_000);
              }),
            ]);
            const discovered = result.context.socialProviders[0];
            if (
              !discovered ||
              typeof discovered === "function" ||
              discovered.issuer !== config.issuer
            )
              throw unavailable();
            provider = discovered;
            availability = "available";
            failures = 0;
            nextAttempt = 0;
            schedule(5 * 60_000);
            return discovered;
          } catch {
            provider = undefined;
            availability = "unavailable";
            const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
            nextAttempt = Date.now() + delay;
            schedule(delay);
            throw unavailable();
          } finally {
            clearTimeout(timeout);
            pending = undefined;
          }
        })();
        return pending;
      };
      schedule(0);
      const getProvider = () => (provider ? Promise.resolve(provider) : discover());
      resolveProvider = getProvider;
      const lazy: Provider = {
        id: "oidc",
        name: config.name,
        issuer: config.issuer,
        requiresIdTokenNonce: true,
        createAuthorizationURL: async (data) => {
          const url = await (await getProvider()).createAuthorizationURL(data);
          // Only authenticated, server-bound reauthentication needs an interactive
          // provider login. Apply these last so client parameters cannot weaken it.
          const expectedUser = (await getOAuthState())?.serverContext?.reauthUserId;
          if (typeof expectedUser === "string") {
            url.searchParams.set("prompt", "login");
            url.searchParams.set("max_age", "0");
          }
          // Better Auth's state read/delete is not atomic. Consume a separate
          // server-side marker before code exchange, including concurrent callbacks.
          // Better Auth's Expo plugin probes providers with a synthetic request
          // that has no ID token nonce. Only real OIDC sign-ins need this marker.
          if (typeof data.idTokenNonce === "string" && data.idTokenNonce.length > 0) {
            await ctx.internalAdapter.createVerificationValue({
              identifier: `oidc-callback-${data.state}`,
              value: data.idTokenNonce,
              expiresAt: new Date(Date.now() + 10 * 60_000),
            });
          }
          return url;
        },
        validateAuthorizationCode: async (data) => {
          const state = await getOAuthState();
          const marker = await ctx.internalAdapter.consumeVerificationValue(
            `oidc-callback-${state?.oauthState}`,
          );
          if (!marker || marker.value !== state?.idTokenNonce) return null;
          return (await getProvider()).validateAuthorizationCode(data);
        },
        getUserInfo: async (tokens) => {
          if (!tokens.idToken) return null;
          let claims: Record<string, unknown>;
          try {
            claims = JSON.parse(
              Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString(),
            );
          } catch {
            return null;
          }
          // Reject malformed identity claims before the library can fall back to
          // userinfo. None of these claims are trusted until verification below.
          if (claims?.iss !== config.issuer || typeof claims.sub !== "string" || !claims.sub.trim())
            return null;
          // The provider verifies the signature, issuer, audience and nonce first.
          const info = await (await getProvider()).getUserInfo(tokens);
          if (!info?.data || !("sub" in info.data) || info.data.sub !== claims.sub) return null;
          const context = (await getOAuthState())?.serverContext;
          if (typeof context?.reauthUserId === "string") {
            const startedAt = context.reauthStartedAt;
            const { auth_time: authTime } = claims;
            const now = Math.floor(Date.now() / 1_000);
            const accountId = oidcAccountSubject(config.issuer, claims.sub);
            const account = await ctx.internalAdapter.findAccountByKey({
              providerId: "oidc",
              accountId,
            });
            const session =
              typeof context.reauthSessionToken === "string"
                ? await ctx.internalAdapter.findSession(context.reauthSessionToken)
                : null;
            if (
              !Array.isArray(context.reauthAccountIds) ||
              !context.reauthAccountIds.includes(accountId) ||
              account?.userId !== context.reauthUserId ||
              session?.user.id !== context.reauthUserId ||
              session.session.expiresAt.getTime() <= Date.now() ||
              typeof startedAt !== "number" ||
              !Number.isSafeInteger(startedAt) ||
              typeof authTime !== "number" ||
              !Number.isFinite(authTime) ||
              authTime < startedAt - OIDC_CLOCK_SKEW ||
              authTime > now + OIDC_CLOCK_SKEW ||
              authTime <= now - OIDC_FRESH_AGE
            )
              return null;
            // Request-local parsed state: never persist callback-derived fields in
            // the reusable OAuth record. Skew must not extend the proof lifetime.
            context.reauthExpiresAt = (Math.min(authTime, now) + OIDC_FRESH_AGE) * 1_000;
          }
          return info;
        },
        accountSubject: async (data) => {
          const resolved = await getProvider();
          if (!resolved.accountSubject) throw unavailable();
          return resolved.accountSubject(data);
        },
        refreshAccessToken: async (token, context) => {
          const resolved = await getProvider();
          if (!resolved.refreshAccessToken) throw unavailable();
          return resolved.refreshAccessToken(token, context);
        },
      };
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
  };
  return {
    plugin,
    availability: () => availability,
    /** The Expo proxy must only send a browser to the provider's real authorization endpoint. */
    isAuthorizationURL: async (value: string) => {
      if (!resolveProvider) return false;
      const endpoint = await (await resolveProvider()).createAuthorizationURL({
        state: "probe",
        codeVerifier: "probe",
        redirectURI: config.issuer,
      });
      const url = URL.parse(value);
      return url?.origin === endpoint.origin && url.pathname === endpoint.pathname;
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function oidcAccountSubject(issuer: string, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("hex");
}

/** Stored ID tokens were verified during linking; bind their subject to the stored account ID. */
export async function isCurrentOidcAccount(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  key: TokenKey,
) {
  if (!issuer || account.providerId !== "oidc") return false;
  const idToken = await openIdToken(key, account.idToken);
  if (!idToken) return false;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return (
      claims.iss === issuer &&
      typeof claims.sub === "string" &&
      account.accountId === oidcAccountSubject(issuer, claims.sub)
    );
  } catch {
    return false;
  }
}
