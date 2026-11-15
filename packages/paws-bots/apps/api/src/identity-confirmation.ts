import { ORPCError } from "@orpc/server";
import type { Auth } from "@rakazo/auth";
import type { Actor } from "@rakazo/contracts";
import { IDENTITY_CONFIRMATION_REQUIRED } from "@rakazo/contracts";

/**
 * Guards a procedure that reveals sensitive data: the calling session must have confirmed its
 * identity within the last few minutes. Clients answer the error by confirming, then retrying.
 */
export async function requireIdentityConfirmation(
  auth: Pick<Auth, "hasRecentIdentityConfirmation">,
  context: { actor: Actor | null; sessionId?: string },
): Promise<void> {
  if (
    context.actor &&
    context.sessionId &&
    (await auth.hasRecentIdentityConfirmation({
      sessionId: context.sessionId,
      userId: context.actor.userId,
    }))
  )
    return;
  throw new ORPCError(IDENTITY_CONFIRMATION_REQUIRED, {
    status: 403,
    message: "Confirm it's you",
  });
}
