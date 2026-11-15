import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { emailLocale, referralEmail } from "@rakazo/auth";
import { ActorSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { isForeignKeyViolation } from "@rakazo/db";
import { unsubscribeUrl } from "./marketing-email.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KIND = "referral-day1";

/** Emails each verified owner once, a day after signup. Accounts past 72 hours are never emailed. */
export function sendReferralEmails(deps: {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  appUrl: string;
  origin: string;
  secret: string;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  return async () => {
    const now = Date.now();
    const users = await deps.prisma.user.findMany({
      where: {
        createdAt: { gte: new Date(now - 3 * DAY_MS), lte: new Date(now - DAY_MS) },
        emailVerified: true,
        marketingEmailOptOutAt: null,
        members: { some: { role: { contains: "owner" } } },
        emailSends: { none: { kind: KIND } },
      },
      select: {
        id: true,
        email: true,
        name: true,
        locale: true,
        members: { select: { role: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    // One at a time: a burst would trip the provider's rate limit, and a claimed send is never retried.
    for (const user of users) {
      // Member roles are comma-separated, so "not-owner" must not match.
      const owner = user.members.some(({ role }) =>
        role.split(",").some((value) => value.trim() === "owner"),
      );
      if (!owner || !ActorSchema.shape.email.safeParse(user.email).success) continue;
      try {
        const message = await referralEmail(
          user,
          deps.appUrl,
          unsubscribeUrl(deps.origin, deps.secret, user.id),
          emailLocale(user.locale),
        );
        // Claim before sending: concurrent instances race on (userId, kind), and an
        // uncertain delivery is never retried.
        const claim = await deps.prisma.emailSend.createMany({
          data: { userId: user.id, kind: KIND },
          skipDuplicates: true,
        });
        if (claim.count > 0) await deps.email.send(message);
      } catch (error) {
        // Account deletion may race the foreign-key insert.
        if (isForeignKeyViolation(error)) continue;
        deps.onError(error);
      }
    }
  };
}
