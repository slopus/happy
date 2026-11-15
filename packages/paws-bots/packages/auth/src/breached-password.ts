import { createHash } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, readResponseWithin } from "@rakazo/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** Routes that set a new password, and the body field that carries it. Sign-in is never checked. */
const NEW_PASSWORD_FIELDS = new Map([
  ["/sign-up/email", "password"],
  ["/change-password", "newPassword"],
  ["/reset-password", "newPassword"],
  ["/set-password", "newPassword"],
]);

const CHECK_TIMEOUT_MS = 3_000;
// A range response, padded or not, runs to tens of kilobytes.
const MAX_RANGE_RESPONSE_BYTES = 256 * 1024;

/**
 * Rejects new passwords found in the Have I Been Pwned corpus. Only a five-character SHA-1
 * prefix leaves the server. The check fails open: when the service is slow or unreachable the
 * request is aborted, the password accepted and the failure logged, so an outside service never
 * blocks sign-up.
 */
export function breachedPasswordCheck() {
  return {
    id: "breached-password-check",
    hooks: {
      before: [
        {
          matcher: (ctx) => NEW_PASSWORD_FIELDS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const field = NEW_PASSWORD_FIELDS.get(ctx.path)!;
            const password: unknown = ctx.body?.[field];
            // Better Auth rejects out-of-range lengths itself; don't send those anywhere.
            if (
              typeof password !== "string" ||
              password.length < MIN_PASSWORD_LENGTH ||
              password.length > MAX_PASSWORD_LENGTH
            )
              return;
            let compromised: boolean;
            try {
              compromised = await isPasswordBreached(password);
            } catch (error) {
              ctx.context.logger.error("Breached password check unavailable", error);
              return;
            }
            if (compromised) {
              throw new APIError("BAD_REQUEST", {
                code: "PASSWORD_COMPROMISED",
                message: "This password appeared in a data breach. Choose another.",
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** Have I Been Pwned k-anonymity range lookup, aborted at the deadline. */
async function isPasswordBreached(password: string): Promise<boolean> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
    headers: { "Add-Padding": "true" },
    signal,
  });
  if (!response.ok) throw new Error(`Breach lookup failed with status ${response.status}`);
  const range = await readResponseWithin(response, {
    maxBytes: MAX_RANGE_RESPONSE_BYTES,
    tooLargeMessage: "Breach lookup response is too large",
    signal,
  });
  const suffix = `${hash.slice(5)}:`;
  for (const line of new TextDecoder().decode(range).split(/\r?\n/)) {
    if (line.toUpperCase().startsWith(suffix)) return Number(line.slice(suffix.length)) > 0;
  }
  return false;
}
