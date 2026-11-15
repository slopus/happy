import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { emailLocale, welcomeEmail } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { Hono } from "hono";

export const UNSUBSCRIBE_PATH = "/api/v1/email/unsubscribe";

function unsubscribeToken(secret: string, userId: string): string {
  return createHmac("sha256", secret).update(`marketing-unsubscribe:${userId}`).digest("base64url");
}

export function unsubscribeUrl(origin: string, secret: string, userId: string): string {
  const url = new URL(UNSUBSCRIBE_PATH, origin);
  url.searchParams.set("user", userId);
  url.searchParams.set("token", unsubscribeToken(secret, userId));
  return url.href;
}

function validToken(secret: string, userId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(secret, userId));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Accounts older than this never get a welcome, including those created before the email existed.
const WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function sendWelcomeEmail(
  deps: {
    prisma: PrismaClient;
    email: TransactionalEmailProvider;
    origin: string;
    secret: string;
    onError: (error: unknown) => void;
  },
  userId: string,
  /** The first sign-in comes before any app reports a language, so its browser's stands in. */
  headers?: Headers,
): Promise<void> {
  try {
    const user = await deps.prisma.user.findFirst({
      where: { id: userId, createdAt: { gte: new Date(Date.now() - WELCOME_WINDOW_MS) } },
      select: { email: true, name: true, locale: true },
    });
    if (!user) return;
    const claim = await deps.prisma.emailSend.createMany({
      data: { userId, kind: "welcome" },
      skipDuplicates: true,
    });
    if (claim.count === 0) return;
    const message = await welcomeEmail(
      user,
      unsubscribeUrl(deps.origin, deps.secret, userId),
      emailLocale(user.locale, headers),
    );
    // The provider tracks the send, so shutdown drains it; sign-in does not wait on delivery.
    void deps.email.send(message).catch(deps.onError);
  } catch (error) {
    deps.onError(error);
  }
}

// GET only confirms: link scanners open every URL in an email. Mail clients POST (RFC 8058).
export function marketingEmailRoutes(prisma: PrismaClient, secret: string) {
  const app = new Hono();
  const verifiedUser = (url: string) => {
    const params = new URL(url).searchParams;
    const userId = params.get("user") ?? "";
    return userId && validToken(secret, userId, params.get("token") ?? "") ? userId : null;
  };
  app.get(UNSUBSCRIBE_PATH, (c) =>
    verifiedUser(c.req.url)
      ? page(
          `<form method="post"><button type="submit">Unsubscribe from Rakazo emails</button></form>`,
        )
      : page("This link is not valid.", 400),
  );
  app.post(UNSUBSCRIBE_PATH, async (c) => {
    const userId = verifiedUser(c.req.url);
    if (!userId) return page("This link is not valid.", 400);
    await runAsSystem("unsubscribe a user from product email", () =>
      prisma.user.updateMany({
        where: { id: userId, marketingEmailOptOutAt: null },
        data: { marketingEmailOptOutAt: new Date() },
      }),
    );
    return page("You're unsubscribed.");
  });
  return app;
}

function page(content: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Rakazo</title></head><body style="font-family: Arial, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 24px">${content}</body></html>`,
    {
      status,
      headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
    },
  );
}
