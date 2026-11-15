import { randomInt } from "node:crypto";
import type { BillingProvider } from "@rakazo/adapter-kit";
import type { BillingStatus } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  extendByokFreePeriod,
  FREE_MONTH_DAYS,
  hasBillingAccess,
  isUniqueViolation,
  reconcileCreditPurchase,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 8;

type Outcome = "declined" | "balance" | "credits" | "free_period";

/**
 * Each owner earns a free month for every invited organization that subscribes with a card no
 * other referral has used.
 */
export function createReferrals(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  webOrigin: string;
}) {
  const { prisma, provider } = deps;
  const rewardCents = BYOK_TIERS.standard.monthlyPriceCents;
  const enabled = rewardCents !== null && Boolean(provider.grantBalanceCredit);

  async function codeFor(organizationId: string): Promise<string> {
    for (;;) {
      const existing = await prisma.referralCode.findUnique({ where: { organizationId } });
      if (existing) return existing.code;
      try {
        const created = await prisma.referralCode.create({
          data: { organizationId, code: newCode() },
        });
        return created.code;
      } catch (error) {
        // A concurrent create for this organization, or a code collision; the next pass settles it.
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  /** Saves the outcome once and returns the stored one, which a concurrent settle may have set. */
  async function decide(organizationId: string, outcome: Outcome, cardFingerprint: string) {
    const undecided = { organizationId, outcome: null };
    try {
      await prisma.referral.updateMany({ where: undecided, data: { outcome, cardFingerprint } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another referral was already settled with this card.
      await prisma.referral.updateMany({ where: undecided, data: { outcome: "declined" } });
    }
    const stored = await prisma.referral.findUniqueOrThrow({
      where: { organizationId },
      select: { outcome: true },
    });
    return stored.outcome;
  }

  async function extendFreePeriod(organizationId: string, referrerOrganizationId: string) {
    await prisma.$transaction(async (tx) => {
      const marked = await tx.referral.updateMany({
        where: { organizationId, rewardedAt: null },
        data: { rewardedAt: new Date() },
      });
      if (marked.count === 0) return;
      await tx.modelCreditAccount.upsert({
        where: { organizationId: referrerOrganizationId },
        create: { organizationId: referrerOrganizationId },
        update: {},
      });
      await extendByokFreePeriod(tx, referrerOrganizationId, FREE_MONTH_DAYS);
    });
  }

  return {
    enabled,
    async status(organizationId: string, isOwner: boolean): Promise<BillingStatus["referral"]> {
      if (!enabled || !isOwner) return null;
      const [code, rewards] = await Promise.all([
        codeFor(organizationId),
        prisma.referral.count({
          where: { referrerOrganizationId: organizationId, rewardedAt: { not: null } },
        }),
      ]);
      return { url: `${deps.webOrigin}/sign-up?ref=${code}`, rewards };
    },

    /** Whether the organization was invited and has not subscribed yet, so its trial is longer. */
    async invited(organizationId: string) {
      if (!enabled) return false;
      const count = await prisma.referral.count({ where: { organizationId, outcome: null } });
      return count > 0;
    },

    /** Only before the organization's first subscription, so nobody claims after paying. */
    async claim(organizationId: string, code: string, userId: string) {
      if (!enabled) return;
      const [referrer, account] = await Promise.all([
        prisma.referralCode.findUnique({ where: { code } }),
        billingAccountForOrganization(prisma, organizationId),
      ]);
      if (!referrer || referrer.organizationId === organizationId || account?.subscribedAt) return;
      // The friend's longer trial is a gift between people, so a code from an organization the
      // claiming owner also belongs to earns nothing. Teammates two companies share do not count.
      const self = await prisma.member.count({
        where: { organizationId: referrer.organizationId, userId },
      });
      if (self > 0) return;
      await prisma.referral.createMany({
        data: [{ organizationId, referrerOrganizationId: referrer.organizationId }],
        skipDuplicates: true,
      });
    },

    /**
     * Called whenever the invited organization's subscription grants access. The outcome is saved
     * before granting and every grant is idempotent, so the next sync finishes an interrupted
     * reward exactly as decided. A failure never blocks the sync.
     */
    async settle(organizationId: string, cardFingerprint: string | undefined) {
      if (!enabled || !cardFingerprint) return;
      try {
        const referral = await prisma.referral.findUnique({
          where: { organizationId },
          select: {
            outcome: true,
            rewardedAt: true,
            referrerOrganizationId: true,
            referrer: { select: { billing: true, modelCredits: { select: { mode: true } } } },
          },
        });
        if (!referral || referral.rewardedAt) return;
        const { billing, modelCredits } = referral.referrer;
        let outcome = referral.outcome;
        if (!outcome) {
          const referrerCard =
            billing &&
            (await provider.getCustomerSubscription(billing.customerId))?.cardFingerprint;
          outcome = await decide(
            organizationId,
            referrerCard === cardFingerprint
              ? "declined"
              : // Monthly credit invoices turn what is paid into credits, so a balance buys nothing.
                modelCredits?.mode === "credits"
                ? "credits"
                : billing && hasBillingAccess(billing.status)
                  ? "balance"
                  : "free_period",
            cardFingerprint,
          );
        }
        const referenceId = `referral_${organizationId}`;
        if (outcome === "free_period")
          return extendFreePeriod(organizationId, referral.referrerOrganizationId);
        if (outcome === "credits")
          await reconcileCreditPurchase(prisma, referral.referrerOrganizationId, {
            id: referenceId,
            amountCents: rewardCents!,
          });
        else if (outcome === "balance" && billing)
          await provider.grantBalanceCredit!(billing.customerId, rewardCents!, referenceId);
        else return;
        await prisma.referral.updateMany({
          where: { organizationId, rewardedAt: null },
          data: { rewardedAt: new Date() },
        });
      } catch (error) {
        getLogger().error("referral reward failed", error);
      }
    },
  };
}

function newCode() {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
}
