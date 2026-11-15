import type { BetterAuthPlugin } from "better-auth";
import { getOAuthState } from "better-auth/api";
import { verifyProviderIdToken } from "better-auth/oauth2";

/** Guard the verified provider identity before Better Auth can create or link accounts. */
export function socialCallbackProtection(): BetterAuthPlugin {
  return {
    id: "social-callback-protection",
    init(ctx) {
      return {
        context: {
          socialProviders: ctx.socialProviders.map((provider) => {
            if (provider.id !== "google" && provider.id !== "apple") return provider;
            return {
              ...provider,
              requiresIdTokenNonce: true,
              createAuthorizationURL: async (data) => {
                const url = await provider.createAuthorizationURL(data);
                if (data.idTokenNonce) url.searchParams.set("nonce", data.idTokenNonce);
                if (data.idTokenNonce) {
                  await ctx.internalAdapter.createVerificationValue({
                    identifier: `identity-callback-${data.state}`,
                    value: `${provider.id}:${data.idTokenNonce}`,
                    // Match Better Auth's OAuth state lifetime, including ordinary sign-in.
                    expiresAt: new Date(Date.now() + 10 * 60_000),
                  });
                }
                return url;
              },
              getUserInfo: async (tokens) => {
                if (
                  tokens.expectedIdTokenNonce &&
                  (!tokens.idToken ||
                    !(await verifyProviderIdToken(
                      provider,
                      tokens.idToken,
                      tokens.expectedIdTokenNonce,
                    )))
                )
                  return null;
                return provider.getUserInfo(tokens);
              },
              validateAuthorizationCode: async (data) => {
                const state = await getOAuthState();
                // Claim before exchange so parallel callbacks cannot both authorize a session.
                if (!state) return null;
                {
                  const marker = await ctx.internalAdapter.consumeVerificationValue(
                    `identity-callback-${state.oauthState}`,
                  );
                  if (
                    !marker ||
                    marker.expiresAt.getTime() <= Date.now() ||
                    marker.value !== `${provider.id}:${state.idTokenNonce}`
                  )
                    return null;
                }
                return provider.validateAuthorizationCode(data);
              },
            };
          }),
        },
      };
    },
  };
}
