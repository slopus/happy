import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import type { ProductAnalytics, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { LAST_SIGN_IN_COOKIE, SignupAttribution } from "@rakazo/contracts";
import {
  displayName,
  emailAllowed,
  isMessagingEmail,
  MAX_PASSWORD_LENGTH,
  MESSAGING_EMAIL_SUFFIX,
  MIN_PASSWORD_LENGTH,
  signupAttributionFromHeaders,
  signupPolicyFromEnv,
} from "@rakazo/core";
import type { PrismaClient, SecurityEventType } from "@rakazo/db";
import {
  bootstrapUserSpace,
  personalOrganizationIds,
  recordSecurityEvent,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { emailOTP, lastLoginMethod, organization } from "better-auth/plugins";
import {
  ACCOUNT_EXPORT_TOKEN_PREFIX,
  consumeAccountExportToken,
  issueAccountExportToken,
} from "./account-export-token.js";
import {
  accountSecurity,
  oidcProofKey,
  sessionForAuthHook,
  signedBearer,
} from "./account-security.js";
import { createAppleClientSecretCache } from "./apple-client-secret.js";
import { breachedPasswordCheck } from "./breached-password.js";
import { DEACTIVATED_AT_FIELD } from "./directory.js";
import type { EmailLocaleOf } from "./email.js";
import { emailLocale, passwordResetEmail, signInCodeEmail, verificationEmail } from "./email.js";
import { hasRecentIdentityConfirmation, identityConfirmation } from "./identity-confirmation.js";
import type { OidcConfig } from "./oidc.js";
import { isCurrentOidcAccount, oidcDiscovery } from "./oidc.js";
import { passkeyRelyingParty } from "./passkey.js";
import type { AppleProviderConfig, GoogleProviderConfig, SocialAuthConfig } from "./social.js";
import {
  appleUserInfo,
  googleEmailVerified,
  isBuiltinAuthorizationURL,
  requestProviderId,
  socialTrustedOrigins,
} from "./social.js";
import { socialCallbackProtection } from "./social-callback-protection.js";
import type { TokenKey } from "./token-storage.js";
import { encryptStoredOAuthTokens, openIdToken, sealIdToken } from "./token-storage.js";

export type { DirectoryAccountChange } from "./directory.js";
export { createDirectory } from "./directory.js";
export {
  emailLocale,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
export type { HomeDeletionReason } from "./home-deletion-email.js";
export { homeDeletionEmail } from "./home-deletion-email.js";
export type { OidcConfig } from "./oidc.js";
export { passkeyRelyingParty } from "./passkey.js";
export {
  integrationClaimConfirmEmail,
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
export { referralEmail } from "./referral-email.js";
export type { SocialAuthConfig } from "./social.js";
export { publicSignInProviders, socialAuthFromFields } from "./social.js";
export { welcomeEmail } from "./welcome-email.js";

export interface AuthEnv {
  analytics?: ProductAnalytics;
  passwordAuth?: boolean;
  /** Opt-in: rejects new passwords found in Have I Been Pwned. Calls an outside service. */
  breachedPasswordCheck?: boolean;
  oidc?: OidcConfig;
  /** Google and Apple, each present only when its credentials are set. */
  social?: SocialAuthConfig;
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  /** Admits a new account only while there is none, for a deployment that serves one person. */
  singleAccount?: boolean;
  extraOrigins?: string[];
  /** SHA-256 signing certificate fingerprints of Android apps allowed to use this server's passkeys. */
  androidAppCertFingerprints?: string[];
  email?: TransactionalEmailProvider;
  logger?: BetterAuthOptions["logger"];
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** Runs when a session row is deleted. Delivery also drops a token whose session is missing or expired. */
  afterDeleteSession?: (session: AuthSession) => Promise<void>;
  /** Runs when a password change replaces the caller's own session instead of ending it. */
  afterReplaceSession?: (previous: AuthSession, session: AuthSession) => Promise<void>;
  /** Runs after each sign-in, with the headers of the request that signed in. */
  afterSignIn?: (userId: string, headers?: Headers) => Promise<void>;
  /** The operator provisions accounts from a directory over SCIM (see `createDirectory`). */
  directoryProvisioning?: boolean;
}

type AuthSession = { id: string; userId: string };

const SEND_SIGN_IN_CODE_PATH = "/email-otp/send-verification-otp";
const CODE_SIGN_IN_PATH = "/sign-in/email-otp";

const CREDENTIAL_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  SEND_SIGN_IN_CODE_PATH,
  CODE_SIGN_IN_PATH,
] as const;

/** Sign-in codes are short-lived, single use and hashed at rest. */
export const SIGN_IN_CODE_EXPIRES_IN_SECONDS = 10 * 60;

/**
 * The email OTP plugin also exposes OTP email verification, password reset and
 * email change. Rakazo uses links for those, so only sign-in codes stay open.
 */
function isUnusedEmailCodePath(path: string, body: { type?: unknown } | undefined): boolean {
  if (path === SEND_SIGN_IN_CODE_PATH) return body?.type !== "sign-in";
  return path.startsWith("/email-otp/") || path === "/forget-password/email-otp";
}

/**
 * The only header Better Auth reads a client IP from. The API sets it from the socket peer and its
 * trusted proxies and drops any client-supplied copy, so a caller cannot choose its own address.
 */
export const CLIENT_IP_HEADER = "x-rakazo-client-ip";

/** Routes that end sessions other than the caller's own sign-out. Recorded per deleted session. */
const REVOCATION_PATHS = new Set(["/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);

/** Successful account changes worth an audit row. Sign-in, sign-up, sign-out and deletion use hooks. */
const ACCOUNT_EVENT_PATHS: Record<string, SecurityEventType> = {
  "/change-password": "auth.password.changed",
  "/set-password": "auth.password.changed",
  "/passkey/verify-registration": "auth.passkey.added",
  "/passkey/update-passkey": "auth.passkey.changed",
  "/passkey/delete-passkey": "auth.passkey.removed",
};

/** Shared across API processes. Off outside production so tests can sign in freely. */
export function authRateLimitOptions(nodeEnv = process.env.NODE_ENV) {
  const rule = { window: 15 * 60, max: 10 };
  return {
    enabled: nodeEnv === "production",
    storage: "database" as const,
    customRules: {
      ...Object.fromEntries(CREDENTIAL_PATHS.map((path) => [path, rule])),
      "/request-account-deletion": { window: 600, max: 3 },
      "/request-identity-code": { window: 600, max: 3 },
      "/confirm-identity": rule,
      "/passkey/verify-authentication": rule,
      "/passkey/verify-registration": rule,
      // Sign-in pages request a challenge on load for passkey autofill.
      "/passkey/generate-authenticate-options": { window: 60, max: 30 },
    },
  };
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  if (env.passwordAuth === false && !env.oidc)
    throw new Error("Password auth requires OIDC when disabled");
  // A failed lookup still sends the email, in the asking browser's language.
  const emailLocaleOf: EmailLocaleOf = async (account, headers) => {
    try {
      const saved = await prisma.user.findUnique({ where: account, select: { locale: true } });
      return emailLocale(saved?.locale, headers);
    } catch {
      return emailLocale(null, headers);
    }
  };
  const discovery = env.oidc ? oidcDiscovery(env.oidc) : undefined;
  /** Whether another account with email sign-in already has a workspace. */
  const hasAdmittedAccount = async (
    client: Pick<PrismaClient, "user" | "spaceMember">,
    exceptUserId?: string,
  ) => {
    const others = await client.user.findMany({
      where: {
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
        NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } },
      },
      select: { id: true },
    });
    return (
      others.length > 0 &&
      Boolean(
        await client.spaceMember.findFirst({
          where: { userId: { in: others.map((other) => other.id) } },
          select: { userId: true },
        }),
      )
    );
  };
  /** Refuses a new account early, before creating it, once a single-person deployment has one. */
  const admission = async () => {
    const policy = signupPolicyFromEnv(env);
    if (!env.singleAccount || !policy.enabled) return policy;
    return (await hasAdmittedAccount(prisma)) ? { ...policy, enabled: false } : policy;
  };
  /** Admits the sole account one at a time, so two first signups cannot both get in. */
  const admitSoleAccount = (userId: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rakazo:single-account'))`;
      if (await hasAdmittedAccount(tx, userId)) return false;
      // Committed before the lock is released, so the next signup sees it.
      await bootstrapUserSpace(prisma, { id: userId }, env);
      return true;
    });
  /** The directory provisioned this account, so it is admitted whatever the signup policy. */
  const provisioned = async (userId: string) =>
    Boolean(env.directoryProvisioning) &&
    Boolean(
      await prisma.scimUser.findFirst({ where: { userId, active: true }, select: { id: true } }),
    );
  /**
   * The directory created this account and nobody has signed in to it yet. Every first
   * sign-in, by any method, gives the account its workspace, so one without a workspace has
   * never been used. Its first SSO sign-in with the same verified email claims it.
   */
  const claimable = async (userId: string) => {
    if (!env.directoryProvisioning) return false;
    const [subject, membership, user] = await Promise.all([
      prisma.scimSubject.findUnique({ where: { userId }, select: { profileSourceId: true } }),
      prisma.spaceMember.findFirst({ where: { userId }, select: { userId: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { deactivatedAt: true } }),
    ]);
    // A deactivated account takes no new login, so nothing is linked while it is off.
    return Boolean(subject?.profileSourceId) && !membership && !user?.deactivatedAt;
  };
  // SSO-only deployments keep every email credential closed, codes included.
  const emailCodeSignIn = Boolean(env.email) && env.passwordAuth !== false;
  // SSO-only deployments keep the identity provider as the only way in.
  const relyingParty =
    env.passwordAuth === false
      ? null
      : passkeyRelyingParty(env.webOrigin, env.androidAppCertFingerprints);
  const google = env.social?.providers.find(
    (provider): provider is GoogleProviderConfig => provider.id === "google",
  );
  const apple = env.social?.providers.find(
    (provider): provider is AppleProviderConfig => provider.id === "apple",
  );
  const appleSecret = apple ? createAppleClientSecretCache(apple) : undefined;
  // Better Auth's own token key, so every stored token shares one cipher and key.
  let authContext: Promise<{ secretConfig: TokenKey }> | undefined;
  const tokenKey = async () => (await authContext!).secretConfig;
  const attributionField = {
    type: "string",
    required: false,
    input: false,
    returned: false,
  } as const;
  const auth = betterAuth({
    appName: "Rakazo",
    logger: env.logger,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: (request) => [
      ...buildTrustedOrigins({
        origins: [env.webOrigin, env.baseURL],
        extraOrigins: env.extraOrigins,
      }),
      APP_SCHEME_ORIGIN,
      ...socialTrustedOrigins(env.social, request),
    ],
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true, trustedProviders: [] },
      encryptOAuthTokens: true,
    },
    // Store only a hash of identifiers that carry an emailed token. Other
    // identifiers hold no secret and stay readable.
    verification: {
      storeIdentifier: {
        default: "plain",
        overrides: {
          "reset-password:": "hashed",
          "delete-account-": "hashed",
          [ACCOUNT_EXPORT_TOKEN_PREFIX]: "hashed",
        },
      },
    },
    rateLimit: authRateLimitOptions(),
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    socialProviders: {
      ...(google
        ? {
            google: {
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              mapProfileToUser: async (profile) => ({
                // An explicit link already proves control of the local account through
                // signed OAuth state; historical mailbox proof alone never admits signup.
                emailVerified:
                  googleEmailVerified(profile) ||
                  (profile.email_verified === true && Boolean((await getOAuthState())?.link)),
              }),
            },
          }
        : {}),
      ...(apple && appleSecret
        ? {
            apple: {
              clientId: apple.clientId,
              get clientSecret() {
                return appleSecret.current();
              },
              getUserInfo: async (token: Parameters<typeof appleUserInfo>[1]) =>
                appleUserInfo(prisma, token, Boolean((await getOAuthState())?.link)),
            },
          }
        : {}),
    },
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: env.passwordAuth !== false,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        await recordSecurityEvent({
          type: "auth.password.changed",
          userId: user.id,
          metadata: { via: "/reset-password" },
        });
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }, request) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void emailLocaleOf({ id: user.id }, request?.headers)
              .then(async (locale) => env.email?.send(await passwordResetEmail(user, url, locale)))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      // Open signups get a session at once; the link only marks the address verified.
      sendOnSignUp: Boolean(env.email),
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }, request) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            const locale = await emailLocaleOf({ id: user.id }, request?.headers);
            await env.email!.send(
              await verificationEmail(user.email, verificationUrl.href, locale),
            );
          }
        : undefined,
    },
    user: {
      // Set by the directory; read with every session so a deactivated account is refused.
      additionalFields: {
        ...DEACTIVATED_AT_FIELD,
        signupSurface: attributionField,
        signupUtmSource: attributionField,
        signupUtmMedium: attributionField,
        signupUtmCampaign: attributionField,
        signupUtmContent: attributionField,
        signupUtmTerm: attributionField,
        signupReferringDomain: attributionField,
      },
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.method !== "oauth") return;
        const providerId = source.oauth?.providerId;
        const reauthentication = (await getOAuthState())?.serverContext;
        const expectedUser = reauthentication?.reauthUserId;
        if (
          typeof expectedUser === "string" &&
          (source.action !== "sign-in" || user.id !== expectedUser)
        )
          return { error: "REAUTHENTICATION_REQUIRED" };
        if (typeof expectedUser === "string") {
          const current = await sessionForAuthHook(ctx);
          if (current && current.session.token !== reauthentication?.reauthSessionToken)
            return { error: "REAUTHENTICATION_REQUIRED" };
        }
        const builtinSocial = providerId === "google" || providerId === "apple";
        if (!builtinSocial && providerId !== "oidc") return;
        const verified = user.emailVerified === true;
        const email = String(user.email ?? "").toLowerCase();
        if (isMessagingEmail(email)) return { error: "EMAIL_NOT_AVAILABLE" };
        if (source.action === "create-user") {
          const policy = await admission();
          const bypassAllowlist = providerId === "oidc" && env.oidc?.allowSignupBypass;
          if (!policy.enabled) return { error: "REGISTRATION_CLOSED" };
          if (!bypassAllowlist && !emailAllowed(email, policy.allowlist))
            return { error: "EMAIL_NOT_ALLOWED" };
          if (!verified && (builtinSocial || (!bypassAllowlist && policy.allowlist.length > 0)))
            return { error: "EMAIL_VERIFICATION_REQUIRED" };
          return;
        }
        if (builtinSocial) {
          // A verified provider email may join an account whose address is already verified.
          if (source.action === "link-account") {
            if (!verified) return { error: "unable_to_link_account" };
            const target = await ctx.context.internalAdapter.findUserById(String(user.id));
            if (!target?.emailVerified) return { error: "unable_to_link_account" };
            if (target.email.toLowerCase() !== email) return { error: "email_does_not_match" };
          }
          return;
        }
        if (source.action === "link-account") {
          if (!verified) return { error: "unable_to_link_account" };
          // Without a link request, this is sign-in finding an account with the same email.
          // Sign-in never links by email, except to claim an account the directory made.
          if (!(await getOAuthState())?.link)
            return (await claimable(String(user.id))) ? undefined : { error: "account_not_linked" };
          // Anyone can register an address, so linking waits for verification. Without email
          // nothing can verify; then only the account's own browser may link, since the
          // native authorization proxy can plant a link state in any other.
          const target = await ctx.context.internalAdapter.findUserById(String(user.id));
          if (
            !target ||
            (!target.emailVerified &&
              (env.email || (await sessionForAuthHook(ctx))?.user.id !== target.id))
          )
            return { error: "unable_to_link_account" };
          return;
        }
        if (source.action === "sign-in" && user.id) {
          const collision = await ctx.context.internalAdapter.findUserByEmail(email);
          if (collision && collision.user.id !== user.id) return { error: "account_not_linked" };
          const stored = await ctx.context.internalAdapter.findUserById(user.id);
          const credential = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (credential?.password && stored?.email.toLowerCase() !== email)
            return { error: "email_does_not_match" };
          // A previous verified claim must not mask a later false/missing claim, and an
          // unverified claim must not move the account onto an address nobody proved.
          await ctx.context.internalAdapter.updateUser(
            user.id,
            verified || stored?.email.toLowerCase() === email
              ? { email, emailVerified: verified }
              : { emailVerified: false },
          );
        }
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          try {
            await env.beforeDeleteUser?.(user.id);
          } catch (error) {
            if (error instanceof SpaceDeletionInProgressError)
              throw new APIError("CONFLICT", { message: error.message });
            throw error;
          }
          const organizationIds = await personalOrganizationIds(prisma, user.id);

          await prisma.$transaction(async (tx) => {
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            await tx.messagingIdentity.deleteMany({
              where: { userId: user.id },
            });
            await tx.passkey.deleteMany({ where: { userId: user.id } });
            await tx.organization.deleteMany({
              where: { id: { in: organizationIds } },
            });
          });
        },
        afterDelete: async (user) => {
          await recordSecurityEvent({ type: "auth.account.deleted", userId: user.id });
        },
      },
    },
    plugins: [
      socialCallbackProtection(),
      signedBearer,
      expo(),
      accountSecurity(
        env.email,
        emailLocaleOf,
        env.oidc?.name,
        env.oidc?.issuer,
        env.passwordAuth !== false,
      ),
      identityConfirmation(env.email, emailLocaleOf),
      ...(discovery ? [discovery.plugin] : []),
      ...(emailCodeSignIn
        ? [
            emailOTP({
              otpLength: 6,
              expiresIn: SIGN_IN_CODE_EXPIRES_IN_SECONDS,
              allowedAttempts: 3,
              storeOTP: "hashed",
              sendVerificationOTP: async ({ email, otp }, ctx) => {
                // Like password reset, do not wait on delivery: a refused address
                // answers at once, so waiting would reveal which addresses are admitted.
                void emailLocaleOf({ email }, ctx?.headers)
                  .then(async (locale) =>
                    env.email?.send(await signInCodeEmail(email, otp, locale)),
                  )
                  .catch((error) => env.onEmailError?.(error));
              },
            }),
          ]
        : []),
      ...(env.breachedPasswordCheck ? [breachedPasswordCheck()] : []),
      // Registration keeps the plugin default: a fresh session of the signed-in user.
      // Sign-in creates its session through the session hooks below like every other method.
      ...(relyingParty
        ? [
            passkey({
              rpID: relyingParty.rpID,
              rpName: "Rakazo",
              origin: relyingParty.origins,
            }) as BetterAuthPlugin,
          ]
        : []),
      // Marks the method on the sign-in page; written only alongside a new session cookie.
      lastLoginMethod({ cookieName: LAST_SIGN_IN_COOKIE }),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const providerId = requestProviderId(ctx);
        if (
          (ctx.path === "/sign-in/social" || ctx.path === "/link-social") &&
          ctx.body?.idToken &&
          (providerId === "google" || providerId === "apple")
        )
          throw new APIError("FORBIDDEN", { message: "Browser sign-in required" });

        if (ctx.path === "/sign-in/social") {
          await addOAuthServerContext({
            signupAttribution: signupAttributionFromHeaders(ctx.headers),
          });
        }
        if (
          ctx.path === "/sign-in/social" &&
          typeof providerId === "string" &&
          ctx.body?.additionalData?.reauthenticate === true
        ) {
          if (providerId !== "oidc") throw new APIError("FORBIDDEN");
          const session = await sessionForAuthHook(ctx);
          if (!session || isMessagingEmail(session.user.email)) throw new APIError("UNAUTHORIZED");
          const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
          const current = await Promise.all(
            accounts.map((account) =>
              isCurrentOidcAccount(account, env.oidc?.issuer, ctx.context.secretConfig),
            ),
          );
          const accountIds = accounts
            .filter((_, index) => current[index])
            .map((account) => account.accountId);
          if (!accountIds.length || ctx.body.idToken) throw new APIError("FORBIDDEN");
          await addOAuthServerContext({
            reauthProviderId: providerId,
            reauthUserId: session.user.id,
            reauthSessionToken: session.session.token,
            reauthAccountIds: accountIds,
            reauthStartedAt: Math.floor(Date.now() / 1_000),
          });
        }
        if (ctx.path === "/expo-authorization-proxy") {
          const authorizationURL = String(ctx.query?.authorizationURL ?? "");
          const builtin =
            env.social?.providers.some((provider) =>
              isBuiltinAuthorizationURL(provider.id, authorizationURL),
            ) ?? false;
          if (!(builtin || (await discovery?.isAuthorizationURL(authorizationURL)))) {
            throw new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });
          }
        }
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        if (
          env.passwordAuth === false &&
          [...CREDENTIAL_PATHS, "/reset-password", "/change-password", "/set-password"].includes(
            ctx.path,
          )
        ) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_AUTH_DISABLED",
            message: "Password authentication is disabled",
          });
        }
        if (ctx.path === "/reset-password") {
          // A reset proves the mailbox, not the logins someone added before it. Clean up
          // first, so a failure leaves the token unused for another try.
          const token = ctx.body?.token ?? ctx.query?.token;
          const reset =
            typeof token === "string"
              ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`)
              : null;
          const user =
            reset && reset.expiresAt > new Date()
              ? await ctx.context.internalAdapter.findUserById(reset.value)
              : null;
          if (user && !user.emailVerified) await revokeUnprovenCredentials(prisma, user.id);
        }
        if (isUnusedEmailCodePath(ctx.path, ctx.body)) throw new APIError("NOT_FOUND");
        if (ctx.path === SEND_SIGN_IN_CODE_PATH || ctx.path === CODE_SIGN_IN_PATH) {
          // A code for an unknown address creates an account, so it passes the
          // same registration policy as password signup. A refused address is
          // answered like any other so replies do not reveal which accounts exist.
          const email = String(ctx.body?.email ?? "")
            .trim()
            .toLowerCase();
          if (!(await ctx.context.internalAdapter.findUserByEmail(email))) {
            const policy = await admission();
            if (!policy.enabled || !emailAllowed(email, policy.allowlist)) {
              if (ctx.path === SEND_SIGN_IN_CODE_PATH) return ctx.json({ success: true });
              throw new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" });
            }
          }
        }
        let policy =
          ctx.path === "/sign-up/email"
            ? await admission()
            : ctx.path === "/sign-in/email"
              ? signupPolicyFromEnv(env)
              : undefined;
        let requireEmailVerification = false;
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw new APIError("BAD_REQUEST", {
              code: "REGISTRATION_CLOSED",
              message: "Registration is closed",
            });
          }
          const email = String(ctx.body?.email ?? "");
          if (!emailAllowed(email, policy.allowlist)) {
            throw new APIError("BAD_REQUEST", {
              code: "EMAIL_NOT_ALLOWED",
              message: "Email is not allowed to register",
            });
          }
          if (policy.allowlist.length > 0 && !env.email) {
            throw new APIError("BAD_REQUEST", {
              message: "Registration requires email delivery",
            });
          }
          requireEmailVerification = policy.allowlist.length > 0;
        } else if (policy) {
          requireEmailVerification = policy.allowlist.length > 0;
        }
        const { findSession, updateUser } = ctx.context.internalAdapter;
        // An SSO sign-in may find an account the directory made; validateUserInfo decides.
        const directoryClaim = Boolean(env.directoryProvisioning) && isOidcCallback(ctx);
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy || directoryClaim
                ? {
                    options: {
                      ...(policy ? { emailAndPassword: { requireEmailVerification } } : {}),
                      ...(directoryClaim
                        ? {
                            account: {
                              accountLinking: {
                                disableImplicitLinking: false,
                                requireLocalEmailVerified: false,
                              },
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Better Auth drops an unverified account's logins and sessions when a
                // code proves the mailbox; credentials Rakazo stores elsewhere go too.
                ...(ctx.path === CODE_SIGN_IN_PATH
                  ? {
                      updateUser: async (...args: Parameters<typeof updateUser>) => {
                        if (args[1].emailVerified === true)
                          await revokeUnprovenCredentials(prisma, args[0]);
                        return updateUser(...args);
                      },
                    }
                  : {}),
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (deactivated(session.user)) return null;
                  if (session.user.emailVerified) return session;
                  if (env.oidc?.allowSignupBypass) {
                    const accounts = await ctx.context.internalAdapter.findAccounts(
                      session.user.id,
                    );
                    if (accounts.some((account) => account.providerId === "oidc")) return session;
                  }
                  policy ??= signupPolicyFromEnv(env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        const accountEvent = ACCOUNT_EVENT_PATHS[ctx.path];
        if (accountEvent && !(ctx.context.returned instanceof APIError)) {
          await recordSecurityEvent({
            type: accountEvent,
            userId: ctx.context.session?.user.id,
            metadata: { via: ctx.path },
          });
        }
        const returned = ctx.context.returned;
        // These routes fall back to the stored ID token, which is sealed at rest.
        if (
          (ctx.path === "/get-access-token" || ctx.path === "/refresh-token") &&
          isRecord(returned) &&
          typeof returned.idToken === "string"
        ) {
          const idToken = await openIdToken(ctx.context.secretConfig, returned.idToken);
          return ctx.json({ ...returned, idToken: idToken ?? undefined });
        }
        const redacted = withoutSessionTokens(ctx.path, returned);
        if (redacted) return ctx.json(redacted);
        const signed = withSignedSessionToken(ctx.context, returned);
        if (signed) return ctx.json(signed);
      }),
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, idToken: await sealIdToken(await tokenKey(), account.idToken) },
          }),
        },
        update: {
          before: async (account) =>
            account.idToken === undefined
              ? undefined
              : {
                  data: {
                    ...account,
                    idToken: await sealIdToken(await tokenKey(), account.idToken),
                  },
                },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = signupPolicyFromEnv(env);
            const oidcSignIn = isOidcCallback(ctx);
            const bypassAllowlist = oidcSignIn && env.oidc?.allowSignupBypass;
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_VERIFICATION_REQUIRED",
                message: "Email verification required",
              });
            }
            if (deactivated(user)) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_DEACTIVATED",
                message: "This account is deactivated",
              });
            }
            if (!user.emailVerified && policy.allowlist.length > 0 && !bypassAllowlist) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_VERIFICATION_REQUIRED",
                message: "Email verification required",
              });
            }
            // Only admitted sessions provision a workspace; never assign administration.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              if (
                (!policy.enabled ||
                  (!bypassAllowlist && !emailAllowed(user.email, policy.allowlist))) &&
                !(await provisioned(user.id))
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "REGISTRATION_CLOSED",
                  message: "Registration is closed",
                });
              }
              if (!env.singleAccount) await bootstrapUserSpace(prisma, user, env);
              else if (!(await admitSoleAccount(user.id)))
                throw new APIError("FORBIDDEN", {
                  code: "REGISTRATION_CLOSED",
                  message: "Registration is closed",
                });
            }
          },
          after: async (session, ctx) => {
            await env.afterSignIn?.(session.userId, ctx?.headers);
            env.analytics?.capture(
              session.userId,
              { name: "signed_in" },
              { id: session.id, at: session.createdAt },
            );
            if (!replacedSession(ctx)) {
              await recordSecurityEvent({
                type: "auth.sign_in",
                userId: session.userId,
                ip: session.ipAddress,
                userAgent: session.userAgent,
                metadata: { via: ctx?.path ?? null },
              });
            }
            const context =
              ctx && ctx.path === "/callback/:id"
                ? (await getOAuthState())?.serverContext
                : undefined;
            // Set only after ID-token verification and exact linked-account binding.
            if (
              ctx &&
              context?.reauthProviderId === "oidc" &&
              context.reauthUserId === session.userId &&
              typeof context.reauthExpiresAt === "number" &&
              context.reauthExpiresAt > Date.now()
            ) {
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: oidcProofKey(session.id),
                value: session.userId,
                expiresAt: new Date(context.reauthExpiresAt),
              });
              await recordSecurityEvent({
                type: "auth.identity.confirmed",
                userId: session.userId,
                metadata: {
                  method: "sso",
                  providerId: "oidc",
                },
              });
            }
            const previous = replacedSession(ctx);
            if (previous) await env.afterReplaceSession?.(previous, session);
          },
        },
        delete: {
          after: async (session, ctx) => {
            if (ctx?.path === "/sign-out") {
              await recordSecurityEvent({ type: "auth.sign_out", userId: session.userId });
            } else if (ctx?.path && REVOCATION_PATHS.has(ctx.path)) {
              await recordSecurityEvent({
                type: "auth.session.revoked",
                userId: session.userId,
                metadata: { via: ctx.path },
              });
            }
            if (replacedSession(ctx)?.id !== session.id) await env.afterDeleteSession?.(session);
          },
        },
      },
      user: {
        create: {
          after: async (user, ctx) => {
            const attribution = SignupAttribution.safeParse({
              surface: user.signupSurface ?? undefined,
              utmSource: user.signupUtmSource ?? undefined,
              utmMedium: user.signupUtmMedium ?? undefined,
              utmCampaign: user.signupUtmCampaign ?? undefined,
              utmContent: user.signupUtmContent ?? undefined,
              utmTerm: user.signupUtmTerm ?? undefined,
              referringDomain: user.signupReferringDomain ?? undefined,
            });
            env.analytics?.capture(
              user.id,
              { name: "account_created", ...(attribution.success ? attribution.data : {}) },
              { id: user.id, at: user.createdAt },
            );
            await recordSecurityEvent({
              type: "auth.sign_up",
              userId: user.id,
              metadata: { via: ctx?.path ?? null },
            });
          },
          before: async (user, ctx = null) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            const callbackAttribution = SignupAttribution.safeParse(
              ctx?.path === "/callback/:id"
                ? (await getOAuthState())?.serverContext?.signupAttribution
                : undefined,
            );
            const attribution = callbackAttribution.success
              ? callbackAttribution.data
              : signupAttributionFromHeaders(ctx?.headers);
            return {
              data: {
                ...user,
                signupSurface: attribution.surface,
                signupUtmSource: attribution.utmSource,
                signupUtmMedium: attribution.utmMedium,
                signupUtmCampaign: attribution.utmCampaign,
                signupUtmContent: attribution.utmContent,
                signupUtmTerm: attribution.utmTerm,
                signupReferringDomain: attribution.referringDomain,
                ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}),
              },
            };
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            return {
              data: {
                ...user,
                ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}),
              },
            };
          },
        },
      },
    },
  });
  authContext = auth.$context;
  return Object.assign(auth, {
    emailCodeSignIn,
    /** Encrypts OAuth tokens stored before encryption was enabled. Safe to rerun. */
    encryptStoredOAuthTokens: async () => encryptStoredOAuthTokens(prisma, await tokenKey()),
    ssoAvailability: () => discovery?.availability(),
    passkeyRpId: relyingParty?.rpID ?? null,
    hasRecentIdentityConfirmation: async (session: { sessionId: string; userId: string }) =>
      hasRecentIdentityConfirmation((await auth.$context).internalAdapter, session),
    issueAccountExportToken: async (userId: string) =>
      issueAccountExportToken((await auth.$context).internalAdapter, userId),
    consumeAccountExportToken: async (token: string) =>
      consumeAccountExportToken((await auth.$context).internalAdapter, token),
    disposeOidcDiscovery: () => {
      discovery?.dispose();
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

async function revokeUnprovenCredentials(prisma: PrismaClient, userId: string) {
  // Auth requests carry a database context, which a batch $transaction([...]) cannot.
  await prisma.$transaction(async (tx) => {
    await tx.passkey.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId, providerId: { not: "credential" } } });
    await tx.messagingIdentity.deleteMany({ where: { userId } });
    await tx.messagingLinkCode.deleteMany({ where: { userId } });
    await tx.userDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}

/**
 * Changing the password with revokeOtherSessions deletes every session, then signs the
 * caller in again, so the caller's device stays signed in under a new session.
 */
function replacedSession(
  ctx: { path?: string; context: { session?: { session: AuthSession } | null } } | null,
): AuthSession | undefined {
  return ctx?.path === "/change-password" ? ctx.context.session?.session : undefined;
}

/**
 * A session token is a bearer credential. Session reads describe sessions
 * without handing any of them out; sign-in and sign-up still return the token
 * they just issued. Returns the redacted body, or undefined to keep it.
 */
function withoutSessionTokens(
  path: string,
  returned: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (path === "/list-sessions" && Array.isArray(returned)) {
    return returned.map(withoutToken);
  }
  if (
    (path === "/get-session" || path === "/update-session") &&
    isRecord(returned) &&
    isRecord(returned.session)
  ) {
    return { ...returned, session: withoutToken(returned.session) };
  }
  return undefined;
}

/**
 * A sign-in body carries the new session's raw token, which the bearer plugin
 * refuses. Swap in the signed value from the session cookie, so a native client
 * that keeps the body token stores a bearer that works.
 */
function withSignedSessionToken(
  context: {
    newSession: { session: { token: string } } | null;
    responseHeaders?: Headers;
    authCookies: { sessionToken: { name: string } };
  },
  returned: unknown,
): Record<string, unknown> | undefined {
  const token = context.newSession?.session.token;
  if (!token || !isRecord(returned)) return undefined;
  const cookie = parseSetCookieHeader(context.responseHeaders?.get("set-cookie") ?? "").get(
    context.authCookies.sessionToken.name,
  );
  if (!cookie?.value || cookie["max-age"] === 0) return undefined;
  const signed = decodeURIComponent(cookie.value);
  if (!signed.startsWith(`${token}.`)) return undefined;
  if (returned.token === token) return { ...returned, token: signed };
  if (isRecord(returned.session) && returned.session.token === token) {
    return { ...returned, session: { ...returned.session, token: signed } };
  }
  return undefined;
}

function withoutToken(session: unknown): unknown {
  if (!isRecord(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface TrustedOriginsInput {
  /** Trusted along with their localhost↔127.0.0.1 twins. */
  origins: string[];
  /** Trusted exactly as given. */
  extraOrigins?: string[];
  /**
   * For matching a request's Origin header: also trust each origin's normalized form and its
   * [::1] twin, and leave out empty values and the app scheme, which that check accepts first.
   */
  requestOrigins?: boolean;
}

/** The one trusted-origin list, for Better Auth and the API's request origin check. */
export function buildTrustedOrigins({
  origins,
  extraOrigins = [],
  requestOrigins = false,
}: TrustedOriginsInput): string[] {
  const listed = requestOrigins
    ? origins.filter((origin) => origin && origin !== APP_SCHEME_ORIGIN)
    : origins;
  const variants = listed.flatMap(requestOrigins ? requestOriginVariants : loopbackTwinOrigins);
  return [...new Set([...listed, ...extraOrigins, ...variants])];
}

const APP_SCHEME_ORIGIN = "rakazo://";

function requestOriginVariants(origin: string): string[] {
  const variants = loopbackTwinOrigins(origin);
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") {
      variants.push(url.origin);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const v6 = new URL(origin);
      v6.hostname = "[::1]";
      variants.push(v6.origin);
    }
  } catch {
    return variants;
  }
  return variants;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/**
 * Spaces are Better Auth organizations, but their lifecycle belongs to the
 * product RPCs. No client calls the organization plugin over HTTP, so every
 * route under it stays closed, including ones a future plugin version adds.
 */
export function isBlockedAuthPath(path: string): boolean {
  return path.startsWith("/organization");
}

/** Set while the directory has turned the account off. */
function deactivated(user: object): boolean {
  return "deactivatedAt" in user && Boolean(user.deactivatedAt);
}

function isOidcCallback(
  ctx: { path?: string; params?: Record<string, unknown> } | null | undefined,
): boolean {
  return ctx?.path === "/callback/:id" && ctx.params?.id === "oidc";
}
