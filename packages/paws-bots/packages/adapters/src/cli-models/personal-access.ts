import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { modelCreditBillingEnabled } from "../run-model.js";

export type PersonalCliAccessCheck = () => Promise<string | undefined>;

export const PERSONAL_CLI_BILLING_REFUSAL =
  "Personal CLI access is turned off on servers that bill for model usage.";
export const PERSONAL_CLI_SHARED_REFUSAL =
  "Personal CLI access runs only on a server with one account, because its sign-in belongs to one person.";

/**
 * A CLI sign-in is one person's plan, so the server must not sell model usage or serve anyone
 * else with it; the hosted service does both. People who only message bots from chat apps have
 * no account to sign in. Checked on every model turn, so a second account is refused at once.
 */
export function personalCliAccessCheck(deps: {
  prisma: PrismaClient;
  billingEnabled?: boolean;
}): PersonalCliAccessCheck {
  return async () => {
    if (await modelCreditBillingEnabled(deps)) return PERSONAL_CLI_BILLING_REFUSAL;
    const people = await runAsSystem("check that Personal CLI access serves one person", () =>
      deps.prisma.user.count({
        where: {
          deactivatedAt: null,
          NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } },
          members: { some: { spaceMemberships: { some: {} } } },
        },
      }),
    );
    return people > 1 ? PERSONAL_CLI_SHARED_REFUSAL : undefined;
  };
}
