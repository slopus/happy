import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { recordSecurityEvent } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { oidcProofKey } from "./account-security.js";
import type { EmailLocaleOf } from "./email.js";
import { identityCodeEmail } from "./email.js";

/** How long one confirmation lets a session reach sensitive data. */
export const IDENTITY_CONFIRMATION_MS = 5 * 60_000;
const CODE_EXPIRES_MS = 10 * 60_000;
const CODE_ATTEMPTS = 3;
const PASSWORD_FAILURES = 5;
const PASSWORD_LOCKOUT_MS = 15 * 60_000;

const confirmationKey = (sessionId: string) => `identity-confirmed-${sessionId}`;
const codeKey = (sessionId: string) => `identity-code-${sessionId}`;
const attemptKey = (userId: string, slot: number) => `identity-attempt-${userId}-${slot}`;

type Verification = { value: string; expiresAt: Date };

/**
 * Claims one of the account's password attempts before the password is checked. Each attempt is
 * its own row created first-writer-wins, so parallel guesses across API processes cannot share one.
 */
async function reservePasswordAttempt(
  adapter: {
    findVerificationValue(identifier: string): Promise<Verification | null>;
    consumeVerificationValue(identifier: string): Promise<Verification | null>;
    reserveVerificationValue(data: Verification & { identifier: string }): Promise<boolean>;
  },
  userId: string,
): Promise<boolean> {
  for (let slot = 0; slot < PASSWORD_FAILURES; slot += 1) {
    const identifier = attemptKey(userId, slot);
    const held = await adapter.findVerificationValue(identifier);
    // An expired attempt frees its slot; consuming it is atomic, so only the reserve below races.
    if (held && held.expiresAt.getTime() <= Date.now())
      await adapter.consumeVerificationValue(identifier);
    const reserved = await adapter.reserveVerificationValue({
      identifier,
      value: userId,
      expiresAt: new Date(Date.now() + PASSWORD_LOCKOUT_MS),
    });
    if (reserved) return true;
  }
  return false;
}

/**
 * Whether this session confirmed its identity within the window: by password or emailed code
 * through `/confirm-identity`, or by a fresh SSO sign-in. Bound to the session and its user.
 */
export async function hasRecentIdentityConfirmation(
  adapter: { findVerificationValue(identifier: string): Promise<Verification | null> },
  session: { sessionId: string; userId: string },
): Promise<boolean> {
  const proofs = await Promise.all(
    [confirmationKey(session.sessionId), oidcProofKey(session.sessionId)].map((identifier) =>
      adapter.findVerificationValue(identifier),
    ),
  );
  return proofs.some(
    (proof) => proof?.value === session.userId && proof.expiresAt.getTime() > Date.now(),
  );
}

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

function sameHash(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

const invalidPassword = () =>
  new APIError("BAD_REQUEST", { message: "Invalid password", code: "INVALID_PASSWORD" });
const expiredCode = () =>
  new APIError("BAD_REQUEST", { message: "Request a new code", code: "OTP_EXPIRED" });

/**
 * Step-up confirmation for the signed-in session. Password accounts confirm with their
 * password; accounts without one use an emailed code or a fresh SSO sign-in, like deletion.
 */
export function identityConfirmation(
  email: TransactionalEmailProvider | undefined,
  emailLocaleOf: EmailLocaleOf,
) {
  return {
    id: "identity-confirmation",
    endpoints: {
      requestIdentityCode: createAuthEndpoint(
        "/request-identity-code",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const adapter = ctx.context.internalAdapter;
          if (!email || (await adapter.findCredentialAccount(user.id))?.password) {
            throw new APIError("BAD_REQUEST", {
              message: "Email codes are not available",
              code: "EMAIL_CODE_UNAVAILABLE",
            });
          }
          const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
          await adapter.deleteVerificationByIdentifier(codeKey(session.id));
          await adapter.createVerificationValue({
            identifier: codeKey(session.id),
            value: `${user.id}:${hashCode(code)}:0`,
            expiresAt: new Date(Date.now() + CODE_EXPIRES_MS),
          });
          const locale = await emailLocaleOf({ id: user.id }, ctx.headers);
          await email.send(await identityCodeEmail(user.email, code, locale));
          return ctx.json({ success: true });
        },
      ),
      confirmIdentity: createAuthEndpoint(
        "/confirm-identity",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const adapter = ctx.context.internalAdapter;
          const body = (ctx.body ?? {}) as { password?: unknown; code?: unknown };
          const hash = (await adapter.findCredentialAccount(user.id))?.password;
          let method: "password" | "email";
          if (hash) {
            if (typeof body.password !== "string" || !body.password) throw invalidPassword();
            if (!(await reservePasswordAttempt(adapter, user.id))) {
              throw new APIError("TOO_MANY_REQUESTS", {
                message: "Too many attempts. Try again later.",
                code: "TOO_MANY_REQUESTS",
              });
            }
            // A wrong password keeps its reserved attempt until the lockout window passes.
            if (!(await ctx.context.password.verify({ hash, password: body.password })))
              throw invalidPassword();
            for (let slot = 0; slot < PASSWORD_FAILURES; slot += 1)
              await adapter.deleteVerificationByIdentifier(attemptKey(user.id, slot));
            method = "password";
          } else {
            const code = typeof body.code === "string" ? body.code.trim() : "";
            if (!code) throw expiredCode();
            // Consuming first makes each stored code single use, even under concurrent guesses.
            const stored = await adapter.consumeVerificationValue(codeKey(session.id));
            const [userId, codeHash, attempts] = stored?.value.split(":") ?? [];
            if (!stored || stored.expiresAt.getTime() <= Date.now() || userId !== user.id)
              throw expiredCode();
            if (!sameHash(codeHash ?? "", hashCode(code))) {
              const next = Number(attempts) + 1;
              if (next >= CODE_ATTEMPTS) {
                throw new APIError("BAD_REQUEST", {
                  message: "Request a new code",
                  code: "TOO_MANY_ATTEMPTS",
                });
              }
              await adapter.createVerificationValue({
                identifier: codeKey(session.id),
                value: `${userId}:${codeHash}:${next}`,
                expiresAt: stored.expiresAt,
              });
              throw new APIError("BAD_REQUEST", { message: "Invalid code", code: "INVALID_OTP" });
            }
            method = "email";
          }
          await adapter.deleteVerificationByIdentifier(confirmationKey(session.id));
          await adapter.createVerificationValue({
            identifier: confirmationKey(session.id),
            value: user.id,
            expiresAt: new Date(Date.now() + IDENTITY_CONFIRMATION_MS),
          });
          await recordSecurityEvent({
            type: "auth.identity.confirmed",
            userId: user.id,
            metadata: { method },
          });
          return ctx.json({ success: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
