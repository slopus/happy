import type { VaultUse } from "@rakazo/contracts";
import { VAULT_ACTIVITY_LIMIT } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, tryRecordAuditEvent } from "@rakazo/db";
import type { BotSecretScope, VaultItemUse } from "./bot-secrets.js";
import { vaultItemId } from "./bot-secrets.js";

/**
 * Record that the vault gave a bot one item's value; never the value. `userId` is the person
 * whose vault holds the item: with the Space and the item's vault it decides where the record
 * lands and whether it names the item there (audit-events.ts). A fill or a request has the site
 * it went to; a command variable goes to the bot's shell, which is no site. A run's use has its
 * run and chat; a routine's check has neither. Never throws, as the audit log never does.
 */
export function recordVaultItemUse(use: {
  bot: { id: string; name: string };
  spaceId: string;
  userId: string;
  runId?: string;
  threadId?: string;
  tool: string;
  item: VaultItemUse;
  site?: string;
}): Promise<boolean> {
  const { item } = use;
  return tryRecordAuditEvent({
    action: "credential.used",
    actor: { type: "bot", id: use.bot.id, label: use.bot.name },
    spaceId: use.spaceId,
    userId: use.userId,
    target: { type: "vault_credential", id: item.id, label: item.name },
    runId: use.runId,
    threadId: use.threadId,
    metadata: {
      tool: use.tool,
      scope: item.spaceId ? "space" : "account",
      name: item.name,
      kind: item.kind,
      site: use.site,
    },
  });
}

// Uses sit in audit logs of organizations the owner may not read, so they are found by the item's
// id only after the caller is shown to own it.
export async function listVaultItemUses(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
): Promise<VaultUse[] | undefined> {
  const id = await vaultItemId(prisma, scope, name);
  if (!id) return undefined;
  return runAsSystem("read a vault item's uses for its owner", async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { targetType: "vault_credential", targetId: id, action: "credential.used" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: VAULT_ACTIVITY_LIMIT * 2,
      select: {
        createdAt: true,
        actorId: true,
        actorLabel: true,
        targetLabel: true,
        runId: true,
        threadId: true,
        metadata: true,
      },
    });
    // A guest's use of an account item is written twice at one time, unnamed in the space's
    // organization and in full in their own, so each unnamed row is dropped for one full row of
    // the same moment, bot, run and chat. An unnamed row with no such twin is a use of its own:
    // a Space vault item's, or a guest's who owns no organization. A full row is told by the
    // item's name, which only it keeps, and not by a site, which a command variable's use has in
    // neither row; full rows are never merged, so a login used on two sites is two.
    const key = (row: (typeof rows)[number]) =>
      JSON.stringify([row.createdAt.getTime(), row.actorId, row.runId, row.threadId]);
    const full = (row: (typeof rows)[number]) => row.targetLabel !== null;
    const twins = new Map<string, number>();
    for (const row of rows) if (full(row)) twins.set(key(row), (twins.get(key(row)) ?? 0) + 1);
    const events = rows
      .filter((row) => {
        if (full(row)) return true;
        const left = twins.get(key(row)) ?? 0;
        if (left) twins.set(key(row), left - 1);
        return left === 0;
      })
      .slice(0, VAULT_ACTIVITY_LIMIT);
    const threadIds = [...new Set(events.flatMap((event) => event.threadId ?? []))];
    // Only the owner's own chats are named.
    const threads = threadIds.length
      ? await prisma.thread.findMany({
          where: { id: { in: threadIds }, userId: scope.userId },
          select: { id: true, bot: { select: { name: true } }, group: { select: { name: true } } },
        })
      : [];
    const chats = new Map(
      threads.flatMap((thread) => {
        const title = thread.group?.name ?? thread.bot?.name;
        return title === undefined ? [] : [[thread.id, { title }] as const];
      }),
    );
    return events.map((event) => {
      const site = (event.metadata as Record<string, unknown> | null)?.site;
      return {
        at: event.createdAt.toISOString(),
        botName: event.actorLabel ?? "",
        site: typeof site === "string" ? site : null,
        chat: (event.threadId && chats.get(event.threadId)) || null,
      };
    });
  });
}
