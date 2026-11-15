import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { appConnectCard, matchAppCatalog, matchesAppConnection } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";

const RECENT_MESSAGES = 50;

/** Catalog data is the only source of card content; serialize dedupe with the message write. */
export async function connectApp(
  deps: { prisma: PrismaClient; events: ThreadEvents },
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
  target: { id: string; spaceId: string; threadId: string; botId: string },
  app: unknown,
  effectId: string,
) {
  if (typeof app !== "string" || !app.trim() || app.length > 100) {
    return { error: "Provide an app name or slug of at most 100 characters." };
  }
  const catalog = (
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const query = await provider.catalog(context, app.trim());
          // A provider's text search may not recognize a featured alias such as gcal.
          const entries = matchAppCatalog(query, app) ? query : await provider.catalog(context);
          return entries.filter((entry) => entry.connectorId === provider.describe().id);
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  // An app connected through any provider counts, even if another provider lists it first.
  const entry =
    matchAppCatalog(
      catalog.filter((item) => item.connected),
      app,
    ) ?? matchAppCatalog(catalog, app);
  if (!entry) return { error: "No such app is available in the connector catalog." };
  const provider = providers.find((provider) => provider.describe().id === entry.connectorId);
  const reconnect =
    entry.connected && ((await provider?.needsReconnect?.(context, entry.slug)) ?? false);
  if (entry.connected && !reconnect)
    return {
      status: "connected",
      message: "This app is already connected and its tools are available.",
    };
  const block = appConnectCard({ ...entry, connected: false });
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const nonce = `connect-app:${effectId}`;
    const replayed = await tx.message.findFirst({
      where: { threadId: target.threadId, clientNonce: nonce },
      select: { id: true },
    });
    if (replayed) return null;
    // Only recent cards count as already shown; an old one far up the chat should not block a new one.
    const recent = await tx.message.findMany({
      where: { threadId: target.threadId },
      select: { blocks: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_MESSAGES,
    });
    if (
      recent.some((message) =>
        (message.blocks as MessageBlock[]).some(
          (candidate) =>
            matchesAppConnection(candidate, entry.connectorId, entry.slug) &&
            candidate.status === "pending",
        ),
      )
    )
      return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      role: "bot",
      blocks: [block],
      clientNonce: nonce,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
    return event;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed)
    await deps.events.notify(
      target.threadId,
      committed.seq,
      committed.firstResponse ? target.id : undefined,
    );
  const shown = committed ? "Connection card shown." : "Connection card already shown.";
  return {
    status: "pending",
    message: reconnect
      ? `${shown} The saved connection gives this app no tools, so the user must reconnect it. Wait for them to do so.`
      : `${shown} Wait for the user to connect the app.`,
  };
}
