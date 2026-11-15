import { AsyncLocalStorage } from "node:async_hooks";
import type { SecurityEvent, SecurityEventMetadata, SecurityEventType } from "@rakazo/contracts";
import { SECURITY_EVENT_TYPES, SecurityEventTypeSchema } from "@rakazo/contracts";
import { getLogContext, getLogger, redactBindings } from "@rakazo/logging";
import { recordAuditEvent } from "./audit-events.js";
import type { PrismaClient } from "./client.js";
import { parsePositiveInteger } from "./client.js";
import { runAsSystem } from "./row-security.js";

export type { SecurityEventType } from "@rakazo/contracts";

type SecurityEventDb = Pick<PrismaClient, "securityEvent">;

export interface SecurityEventInput {
  type: SecurityEventType;
  /** Defaults to the request's log context. */
  userId?: string | null;
  spaceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Identifiers, kinds, and outcomes. Content-like keys and non-scalar values are dropped. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

const securityRequest = new AsyncLocalStorage<{ ip?: string; userAgent?: string }>();

/** Keep caller details available only to security events within this request. */
export function withSecurityRequest<T>(
  caller: { ip?: string; userAgent?: string },
  fn: () => T,
): T {
  return securityRequest.run(caller, fn);
}

export function securityRequestCaller(): { ip?: string; userAgent?: string } | undefined {
  return securityRequest.getStore();
}

const FAILURE_TYPES = new Set<SecurityEventType>([
  "auth.sign_in.failed",
  "auth.sign_up.failed",
  "egress.refused",
  "rate_limit.hit",
]);
/** Deployment-wide signals with no account or organization to attribute them to. */
const NOT_AUDITED = new Set<SecurityEventType>([...FAILURE_TYPES, "deployment.settings.changed"]);
/** Done to an account by the directory or the operator (`metadata.by`), not by the account itself. */
const DONE_TO_ACCOUNT = new Set<SecurityEventType>([
  "auth.account.deactivated",
  "auth.account.reactivated",
]);
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING = 200;
/** Keys that could carry what a user said or a secret. Never stored, whatever the value. */
const CONTENT_KEY =
  /content|message|prompt|body|text|answer|instruction|password|passwd|secret|token|cookie|authorization|credential|api_?key|code|email/i;

let store: SecurityEventDb | undefined;

/** Composition roots install the database once; until then events only reach the log. */
export function installSecurityEventStore(db: SecurityEventDb | undefined): void {
  store = db;
}

/**
 * Record one security event: a structured `security.event` log line for the log sink, plus an
 * append-only row. An account's own action is also appended to its organization's audit log.
 * Never throws; a failed write is logged and the caller carries on.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  const context = getLogContext();
  const caller = securityRequest.getStore();
  const event = {
    type: input.type,
    userId: bounded(input.userId ?? context["user.id"], 128),
    spaceId: bounded(input.spaceId ?? context["space.id"], 128),
    ip: bounded(input.ip ?? caller?.ip, 64),
    userAgent: bounded(input.userAgent ?? caller?.userAgent, 512),
    metadata: securityEventMetadata(input.metadata),
  };
  const level = FAILURE_TYPES.has(event.type) ? "warn" : "info";
  getLogger()[level]("security.event", {
    "security.event.type": event.type,
    "user.id": event.userId ?? undefined,
    "space.id": event.spaceId ?? undefined,
    "client.ip": event.ip ?? undefined,
    "user_agent.original": event.userAgent ?? undefined,
    "security.event.metadata": event.metadata,
  });
  if (store) {
    try {
      // An event may name another user or no Space at all, and must never be lost to
      // the caller's tenant; the table is only ever read as system.
      const db = store;
      await runAsSystem("append a security event", () => db.securityEvent.create({ data: event }));
    } catch (error) {
      getLogger().error("security.event.write_failed", error);
    }
  }
  if (event.userId && !NOT_AUDITED.has(event.type)) {
    const { kind, runId, by } = event.metadata;
    const userId = event.userId;
    await withSecurityRequest(
      { ip: event.ip ?? undefined, userAgent: event.userAgent ?? undefined },
      () =>
        recordAuditEvent({
          action: event.type,
          ...(DONE_TO_ACCOUNT.has(event.type)
            ? {
                actor: { type: "system", label: typeof by === "string" ? by : "system" },
                target: { type: "user", id: userId },
              }
            : {
                actor: { type: "user", id: userId },
                target: typeof kind === "string" ? { type: kind } : undefined,
              }),
          spaceId: event.spaceId,
          // Every vault item is its person's own; see the vault rule in audit-events.ts.
          userId: kind === "vault_credential" ? userId : undefined,
          runId: typeof runId === "string" ? runId : undefined,
          metadata: event.metadata,
        }),
    );
  }
}

export function securityEventMetadata(
  metadata: SecurityEventInput["metadata"] = {},
): SecurityEventMetadata {
  const kept: SecurityEventMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(kept).length >= MAX_METADATA_KEYS) break;
    if (CONTENT_KEY.test(key) || key.length > 64) continue;
    if (value === undefined) continue;
    if (typeof value === "string") kept[key] = value.slice(0, MAX_METADATA_STRING);
    else if (typeof value === "boolean" || value === null) kept[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
  }
  // Values are identifiers, but an email or key pasted where an id belongs is still redacted.
  return redactBindings(kept) as SecurityEventMetadata;
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

export const DEFAULT_SECURITY_EVENT_RETENTION_DAYS = 90;

export function securityEventRetentionDays(source: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(
    source.SECURITY_EVENT_RETENTION_DAYS,
    DEFAULT_SECURITY_EVENT_RETENTION_DAYS,
  );
}

export async function pruneSecurityEvents(
  db: SecurityEventDb,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

export function createSecurityEventPruner(
  db: SecurityEventDb,
  retentionDays: number,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  return createRetentionPruner(
    "security.event",
    (at) => pruneSecurityEvents(db, retentionDays, at),
    options,
  );
}

/** A pruner for a frequent reconciler tick that only touches its table about once an hour. */
export function createRetentionPruner(
  event: string,
  prune: (at: Date) => Promise<number>,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  let lastRun: number | undefined;
  return async () => {
    const at = now();
    if (lastRun !== undefined && at.getTime() - lastRun < intervalMs) return;
    lastRun = at.getTime();
    const removed = await prune(at);
    if (removed > 0) getLogger().info(`${event}.pruned`, { [`${event}.removed`]: removed });
  };
}

export async function listSecurityEvents(
  db: SecurityEventDb,
  input: { type?: SecurityEventType; ip?: string; userId?: string; cursor?: string; limit: number },
): Promise<SecurityEvent[]> {
  const after = input.cursor
    ? await db.securityEvent.findUnique({
        where: { id: input.cursor },
        select: { id: true, createdAt: true },
      })
    : null;
  if (input.cursor && !after) return [];
  const rows = await db.securityEvent.findMany({
    where: {
      // Only types this release knows, filtered before `take` so a page is never emptied by
      // events a newer release wrote before a rollback.
      type: input.type ?? { in: [...SECURITY_EVENT_TYPES] },
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      // Same order as the sort, so events sharing a timestamp are neither skipped nor repeated.
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit,
  });
  return rows.flatMap((row) => {
    const type = SecurityEventTypeSchema.safeParse(row.type);
    if (!type.success) return [];
    return [
      {
        id: row.id,
        type: type.data,
        userId: row.userId,
        spaceId: row.spaceId,
        ip: row.ip,
        userAgent: row.userAgent,
        metadata: (row.metadata ?? {}) as SecurityEventMetadata,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}
