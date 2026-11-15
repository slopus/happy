import type { PrismaClient } from "./client.js";

/**
 * Expiry stored for a session, including one that is already past. Null means
 * the row is gone. Callers tell expiry apart from deletion: a password change
 * deletes the old row before the replacement session exists.
 */
export async function pushSessionExpiresAt(
  prisma: Pick<PrismaClient, "session">,
  sessionId: string,
): Promise<Date | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true },
  });
  return session?.expiresAt ?? null;
}
