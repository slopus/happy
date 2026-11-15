import { ORPCError } from "@orpc/server";
import { IDENTITY_CONFIRMATION_REQUIRED, isIdentityConfirmationRequired } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { requireIdentityConfirmation } from "./identity-confirmation.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};

it("passes a session that recently confirmed its identity", async () => {
  const hasRecentIdentityConfirmation = vi.fn(async () => true);
  await requireIdentityConfirmation(
    { hasRecentIdentityConfirmation },
    { actor, sessionId: "session-1" },
  );
  expect(hasRecentIdentityConfirmation).toHaveBeenCalledWith({
    sessionId: "session-1",
    userId: "user-1",
  });
});

// Without a session or actor the guard must refuse even if a confirmation lookup would pass.
it.each([
  ["an unconfirmed session", { actor, sessionId: "session-1" }, false],
  ["a caller without a session", { actor }, true],
  ["a signed-out caller", { actor: null, sessionId: "session-1" }, true],
])("refuses %s with a stable code", async (_name, context, confirmed) => {
  const error = await requireIdentityConfirmation(
    { hasRecentIdentityConfirmation: async () => confirmed },
    context,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({ code: IDENTITY_CONFIRMATION_REQUIRED, status: 403 });
  expect(isIdentityConfirmationRequired(error)).toBe(true);
});
