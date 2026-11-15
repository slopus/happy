import type { PrismaClient } from "@rakazo/db";
import {
  auditEventDto,
  auditEventRetentionDays,
  createRetentionPruner,
  pruneAuditEvents,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Rows are written outside transactions, but instances commit a moment apart. Forwarding only
 * events older than this keeps a late commit from landing behind the cursor.
 */
const SETTLE_MS = 60_000;
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_PASS = 10;
const MAX_BACKOFF_MS = 60 * 60_000;
const TIMEOUT_MS = 10_000;

export interface AuditLogConfig {
  retentionDays: number;
  webhook?: { url: string; authorization?: string };
}

export function auditLogConfig(env: NodeJS.ProcessEnv = process.env): AuditLogConfig {
  const url = env.AUDIT_LOG_WEBHOOK_URL?.trim();
  const authorization = env.AUDIT_LOG_WEBHOOK_AUTHORIZATION?.trim();
  if (url && new URL(url).protocol !== "https:" && !isLoopback(new URL(url).hostname))
    throw new Error("AUDIT_LOG_WEBHOOK_URL must be an https URL");
  return {
    retentionDays: auditEventRetentionDays(env),
    ...(url ? { webhook: { url, ...(authorization ? { authorization } : {}) } } : {}),
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Prunes past retention and forwards new events, for the elected reconciler's tick. */
export function createAuditLogReconciler(
  prisma: Pick<PrismaClient, "auditEvent" | "auditEventForwarding">,
  config: AuditLogConfig,
  options: { fetch?: typeof fetch; now?: () => Date; intervalMs?: number } = {},
): () => Promise<void> {
  const now = options.now ?? (() => new Date());
  const prune = createRetentionPruner(
    "audit.event",
    (at) =>
      runAsSystem("prune the audit log", () => pruneAuditEvents(prisma, config.retentionDays, at)),
    { now, intervalMs: options.intervalMs },
  );
  const forward = config.webhook
    ? createAuditEventForwarder(prisma, config.webhook, { fetch: options.fetch, now })
    : undefined;
  return async () => {
    const results = await Promise.allSettled([prune(), forward?.()]);
    for (const result of results)
      if (result.status === "rejected")
        getLogger().error("audit.event.reconcile_failed", result.reason);
  };
}

/**
 * Posts events oldest first as JSON Lines, at least once: a receiver dedupes by `id`. A failed
 * post keeps the cursor and retries with backoff.
 */
export function createAuditEventForwarder(
  prisma: Pick<PrismaClient, "auditEvent" | "auditEventForwarding">,
  webhook: NonNullable<AuditLogConfig["webhook"]>,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): () => Promise<void> {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  return () =>
    runAsSystem("forward the audit log", async () => {
      const at = now();
      const state = await prisma.auditEventForwarding.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      });
      if (state.nextAttemptAt && state.nextAttemptAt > at) return;
      let cursor =
        state.lastCreatedAt && state.lastEventId
          ? { createdAt: state.lastCreatedAt, id: state.lastEventId }
          : undefined;
      const settled = new Date(at.getTime() - SETTLE_MS);
      for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
        const rows = await prisma.auditEvent.findMany({
          where: {
            createdAt: { lt: settled },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: BATCH_SIZE,
        });
        if (!rows.length) return;
        const failure = await post(
          send,
          webhook,
          rows.map((row) => JSON.stringify(auditEventDto(row))),
        );
        if (failure) {
          const failures = state.failures + 1;
          await prisma.auditEventForwarding.update({
            where: { id: "default" },
            data: {
              failures,
              nextAttemptAt: new Date(
                at.getTime() + Math.min(30_000 * 2 ** (failures - 1), MAX_BACKOFF_MS),
              ),
            },
          });
          getLogger().warn("audit.event.forward_failed", {
            "audit.event.forward.failures": failures,
            "audit.event.forward.reason": failure,
          });
          return;
        }
        const last = rows.at(-1)!;
        cursor = { createdAt: last.createdAt, id: last.id };
        state.failures = 0;
        await prisma.auditEventForwarding.update({
          where: { id: "default" },
          data: {
            lastCreatedAt: last.createdAt,
            lastEventId: last.id,
            failures: 0,
            nextAttemptAt: null,
          },
        });
        if (rows.length < BATCH_SIZE) return;
      }
    });
}

/** The reason a post failed, or undefined when the receiver accepted it. */
async function post(
  send: typeof fetch,
  webhook: NonNullable<AuditLogConfig["webhook"]>,
  lines: string[],
): Promise<string | undefined> {
  try {
    const response = await send(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        ...(webhook.authorization ? { authorization: webhook.authorization } : {}),
      },
      body: `${lines.join("\n")}\n`,
      // A redirect would resend the events, and possibly the credential, somewhere unconfigured.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok ? undefined : `status ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.name : "error";
  }
}
