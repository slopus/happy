import { createDb } from "@rakazo/db";

/** Keep the shared fixture healthy outside this section, including failed captures. */
export async function captureIosProviderLimitError(
  databaseUrl: string,
  botId: string,
  capture: () => Promise<void>,
): Promise<void> {
  const db = createDb(databaseUrl, { applicationName: "ios-screenshots" });
  try {
    const run = await db.prisma.run.findFirstOrThrow({
      where: { botId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true, error: true, updatedAt: true },
    });
    await db.prisma.run.update({
      where: { id: run.id },
      data: {
        status: "failed",
        error: `403: ${JSON.stringify({ message: "OpenRouter key limit exceeded (weekly limit)", code: 403, metadata: { limit_source: "openrouter_key_limit", reset_at: new Date(Date.now() + 86_400_000).toISOString() } })}`,
      },
    });
    try {
      await capture();
    } finally {
      await db.prisma.run.update({
        where: { id: run.id },
        data: { status: run.status, error: run.error, updatedAt: run.updatedAt },
      });
    }
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
