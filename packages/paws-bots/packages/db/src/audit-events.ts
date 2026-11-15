import type {
  AuditEvent,
  AuditEventFilter,
  AuditEventListInput,
  AuditEventMetadata,
  AuditEventPage,
  AuditOutcome,
} from "@rakazo/contracts";
import { AuditActorTypeSchema, AuditOutcomeSchema } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { GUEST_ROLE, ownedOrganizationId } from "./billing.js";
import type { Prisma, PrismaClient } from "./client.js";
import { parsePositiveInteger } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { securityEventMetadata, securityRequestCaller } from "./security-events.js";

type AuditEventDb = Pick<PrismaClient, "auditEvent" | "space" | "user" | "member">;
type AuditEventRow = Prisma.AuditEventGetPayload<object>;

export interface AuditEventInput {
  /** A stable dotted name, such as `tool.call` or `space.deleted`. */
  action: string;
  actor:
    | { type: "user"; id: string }
    | { type: "bot"; id: string; label: string }
    | { type: "system"; label?: string };
  /** The space acted in; its organization owns the event. */
  spaceId?: string | null;
  /**
   * The person whose vault holds the item the event names: the acting user, or the run's for a
   * bot's use. It decides whether the event may name the item; only an account vault item's event
   * goes on to their own organization.
   */
  userId?: string;
  /** For a space that may already be gone. Without either, a user's event goes to each of their organizations. */
  organizationId?: string;
  spaceName?: string;
  target?: { type: string; id?: string | null; label?: string | null };
  outcome?: AuditOutcome;
  runId?: string | null;
  threadId?: string | null;
  /** Identifiers, kinds, and outcomes. Content-like keys and non-scalar values are dropped. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Where an event about a vault item lands and what it says there, the one place this is decided.
 * - A Space vault item (`scope: "space"`), whatever the event: rows only in the Space's
 *   organization, naming the item, its username or its site only when the acting person is a full
 *   member of it; for a guest, or someone who has left, the row keeps just these fields and no
 *   target label. No row goes to any other organization.
 * - An account vault item is its person's own. Their own action on it lands only in their own
 *   organization, or withheld in the Space's when they own none. A bot's use of it in a Space run
 *   lands in the Space's organization, withheld for a guest, who also gets the named row, without
 *   the Space's name, in the oldest organization they own.
 * - Without a vault scope (an older client), an event in a Space is treated as a Space vault item.
 */
const VAULT_TARGETS = new Set(["vault_credential", "bot_secret"]);
const VAULT_FIELDS_FOR_OTHERS = new Set(["procedure", "kind", "scope", "tool"]);

let store: AuditEventDb | undefined;

/** Composition roots install the database once; until then events only reach the log on failure. */
export function installAuditEventStore(db: AuditEventDb | undefined): void {
  store = db;
}

/**
 * Append one audit event. Never throws: the action it records already happened. A failed
 * write logs the whole event, so the record still reaches the log sink.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  await tryRecordAuditEvent(input);
}

/** Whether the database accepted the event; lets callers retry without suppressing a use. */
export async function tryRecordAuditEvent(input: AuditEventInput): Promise<boolean> {
  const db = store;
  if (!db) return false;
  const caller = input.actor.type === "user" ? securityRequestCaller() : undefined;
  try {
    return await runAsSystem("append an audit event", async () => {
      const rows = await auditRows(db, input, caller);
      if (!rows.length) return false;
      await db.auditEvent.createMany({ data: rows });
      return true;
    });
  } catch (error) {
    getLogger().error("audit.event.write_failed", error, {
      "audit.event.action": input.action,
      "audit.event.actor": `${input.actor.type}:${"id" in input.actor ? input.actor.id : ""}`,
      "audit.event.space_id": input.spaceId ?? input.organizationId ?? undefined,
      "audit.event.target": input.target
        ? `${input.target.type}:${input.target.id ?? ""}`
        : undefined,
      "audit.event.outcome": input.outcome ?? "success",
      "audit.event.run_id": input.runId ?? undefined,
      "audit.event.metadata": securityEventMetadata(input.metadata),
    });
    return false;
  }
}

async function auditRows(
  db: AuditEventDb,
  input: AuditEventInput,
  caller: { ip?: string; userAgent?: string } | undefined,
): Promise<Prisma.AuditEventCreateManyInput[]> {
  const { actor } = input;
  // The person the event is about: the acting user, or a user something was done to.
  const personId =
    actor.type === "user"
      ? actor.id
      : input.target?.type === "user"
        ? (input.target.id ?? undefined)
        : undefined;
  const [space, user, memberships] = await Promise.all([
    input.spaceId
      ? db.space.findUnique({
          where: { id: input.spaceId },
          select: { organizationId: true, name: true },
        })
      : null,
    personId ? db.user.findUnique({ where: { id: personId }, select: { email: true } }) : null,
    !input.spaceId && !input.organizationId && personId
      ? // A guest's own account events are not the business of the organizations that invited them.
        db.member.findMany({
          where: { userId: personId, role: { not: GUEST_ROLE } },
          select: { organizationId: true },
        })
      : [],
  ]);
  // The person whose vault holds the item (see VAULT_TARGETS), when the event is about one.
  const owner =
    VAULT_TARGETS.has(input.target?.type ?? "") && !input.organizationId
      ? (input.userId ?? personId)
      : undefined;
  // Only an account vault item is its person's own, to follow them to their own organization.
  const ownItem = Boolean(owner) && input.metadata?.scope === "account";
  // Whether that person is only a guest of the space's organization, or no longer in it, so the
  // row there must not name the item, whichever vault holds it.
  const outsider =
    space && owner
      ? await db.member
          .findUnique({
            where: {
              organizationId_userId: { organizationId: space.organizationId, userId: owner },
            },
            select: { role: true },
          })
          .then((member) => !member || member.role === GUEST_ROLE)
      : false;
  // Their own organization, computed only for an account vault item: nothing of a Space vault
  // item, or of one whose vault isn't said, leaves the Space's organization.
  const personal =
    owner && ownItem && (outsider || actor.type === "user")
      ? await ownedOrganizationId(db, owner).catch((error: unknown) => {
          if (error instanceof IsolationError) return undefined;
          throw error;
        })
      : undefined;
  // Their own action on an account vault item happened in no space, so it is theirs alone.
  const ownTrail = actor.type === "user" && personal;
  const landings: { organizationId: string; withheld: boolean }[] = input.organizationId
    ? [{ organizationId: input.organizationId, withheld: false }]
    : space
      ? [
          ...(ownTrail
            ? []
            : [
                {
                  organizationId: space.organizationId,
                  withheld: outsider || (ownItem && actor.type === "user"),
                },
              ]),
          ...(personal ? [{ organizationId: personal, withheld: false }] : []),
        ]
      : memberships.map((member) => ({ organizationId: member.organizationId, withheld: false }));
  const row = {
    spaceId: bounded(input.spaceId, 128),
    spaceName: bounded(input.spaceName ?? space?.name, 200),
    actorType: actor.type,
    actorId: "id" in actor ? bounded(actor.id, 128) : null,
    actorLabel: bounded(actor.type === "user" ? user?.email : actor.label, 200),
    action: input.action.slice(0, 128),
    targetType: bounded(input.target?.type, 64),
    targetId: bounded(input.target?.id, 200),
    targetLabel: bounded(input.target?.label ?? (actor.type === "user" ? null : user?.email), 200),
    outcome: input.outcome ?? "success",
    runId: bounded(input.runId, 128),
    threadId: bounded(input.threadId, 128),
    ip: bounded(caller?.ip, 64),
    userAgent: bounded(caller?.userAgent, 512),
    metadata: securityEventMetadata(input.metadata),
    // One time for both rows of a guest's vault event, so its owner's activity lists it once.
    ...(owner && landings.length > 1 ? { createdAt: new Date() } : {}),
  };
  const withheld = {
    ...row,
    targetLabel: null,
    metadata: securityEventMetadata(
      Object.fromEntries(
        Object.entries(input.metadata ?? {}).filter(([key]) => VAULT_FIELDS_FOR_OTHERS.has(key)),
      ),
    ),
  };
  return landings.map((landing) => ({
    ...(landing.withheld ? withheld : row),
    // The shared space's name is its organization's; the person's own keeps only its id.
    ...(landing.organizationId === personal ? { spaceName: null } : {}),
    organizationId: landing.organizationId,
  }));
}

function bounded(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

/** The memberships that may read the audit log of the organization that owns this space. */
function auditLogReaderWhere(spaceId: string): Prisma.MemberWhereInput {
  return { role: { in: ["owner", "admin"] }, organization: { spaces: { some: { id: spaceId } } } };
}

/** The organization whose audit log this actor may read, if any. */
export async function auditLogOrganization(
  db: Pick<PrismaClient, "member">,
  actor: { userId: string; spaceId: string },
): Promise<string | null> {
  const member = await db.member.findFirst({
    where: { userId: actor.userId, ...auditLogReaderWhere(actor.spaceId) },
    select: { organizationId: true },
  });
  return member?.organizationId ?? null;
}

function filterWhere(
  organizationId: string,
  filter: AuditEventFilter,
): Prisma.AuditEventWhereInput {
  return {
    organizationId,
    ...(filter.spaceId ? { spaceId: filter.spaceId } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: new Date(filter.from) } : {}),
            ...(filter.to ? { lt: new Date(filter.to) } : {}),
          },
        }
      : {}),
  };
}

/** One organization's events, newest first. The caller has already authorized the organization. */
export async function listAuditEvents(
  db: Pick<PrismaClient, "auditEvent">,
  organizationId: string,
  input: AuditEventListInput,
): Promise<AuditEventPage> {
  const after = input.cursor
    ? await db.auditEvent.findFirst({
        where: { id: input.cursor, organizationId },
        select: { id: true, createdAt: true },
      })
    : null;
  if (input.cursor && !after) return { events: [], nextCursor: null };
  const rows = await db.auditEvent.findMany({
    where: {
      ...filterWhere(organizationId, input),
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
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  return {
    events: page.map(auditEventDto),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every matching event, newest first, as JSON Lines. */
export async function* exportAuditEvents(
  db: Pick<PrismaClient, "auditEvent">,
  organizationId: string,
  filter: AuditEventFilter,
): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const page = await runAsSystem("export the audit log", () =>
      listAuditEvents(db, organizationId, { ...filter, cursor, limit: 500 }),
    );
    for (const event of page.events) yield `${JSON.stringify(event)}\n`;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

export function auditEventDto(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    organizationId: row.organizationId,
    spaceId: row.spaceId,
    spaceName: row.spaceName,
    actorType: AuditActorTypeSchema.catch("system").parse(row.actorType),
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    outcome: AuditOutcomeSchema.catch("success").parse(row.outcome),
    runId: row.runId,
    threadId: row.threadId,
    ip: row.ip,
    userAgent: row.userAgent,
    metadata: (row.metadata ?? {}) as AuditEventMetadata,
  };
}

export const DEFAULT_AUDIT_EVENT_RETENTION_DAYS = 365;

export function auditEventRetentionDays(source: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(
    source.AUDIT_EVENT_RETENTION_DAYS,
    DEFAULT_AUDIT_EVENT_RETENTION_DAYS,
  );
}

export async function pruneAuditEvents(
  db: Pick<PrismaClient, "auditEvent">,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
