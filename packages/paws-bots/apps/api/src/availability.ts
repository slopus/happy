import { ORPCError } from "@orpc/server";
import type { AccountItem, Actor, AvailabilityKind, SpaceAvailability } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  availableInSpace,
  isUniqueViolation,
  runAsSystem,
  runAsSystemInTransaction,
  spaceAvailability,
} from "@rakazo/db";

/** Serializes one owner's writes of a kind across all their spaces, until the transaction ends. */
export function lockOwner(tx: Prisma.TransactionClient, userId: string, scope: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${userId}`}, 0))`;
}

/** What a user adds themselves follows them into every space; see VISION.md. */
export function userAddedAvailability(actor: Pick<Actor, "spaceId">): SpaceAvailability {
  return { allSpaces: true, spaceIds: [actor.spaceId] };
}

function overlaps(a: SpaceAvailability, b: SpaceAvailability): boolean {
  return a.allSpaces || b.allSpaces || a.spaceIds.some((id) => b.spaceIds.includes(id));
}

const CONFLICT_MESSAGE = {
  skill: "A skill with that name already exists in one of these spaces.",
  mcpServer: "An MCP server with that name already exists in one of these spaces.",
} as const;

/**
 * A skill name or MCP server slug must stay unique wherever its owner can see it. The owner's
 * rows in their other spaces are only reachable across tenants, so this reads them explicitly
 * by owner rather than through the current space.
 */
export async function assertNameFreeWhereAvailable(
  tx: Prisma.TransactionClient,
  kind: "skill" | "mcpServer",
  actor: Pick<Actor, "userId">,
  name: string,
  availability: SpaceAvailability,
  excludeId?: string,
): Promise<void> {
  // Held until the caller's write commits, so two spaces can't both claim a name at once.
  await lockOwner(tx, actor.userId, `names:${kind}`);
  const read = async () =>
    kind === "skill"
      ? tx.agentSkill.findMany({
          where: {
            userId: actor.userId,
            name: { equals: name, mode: "insensitive" },
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
          },
          select: { spaceId: true, allSpaces: true, availableIn: AVAILABILITY_SELECT },
        })
      : tx.mcpServer.findMany({
          where: {
            userId: actor.userId,
            slug: name,
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
          },
          select: { spaceId: true, allSpaces: true, availableIn: AVAILABILITY_SELECT },
        });
  const rows = await runAsSystemInTransaction(tx, "owner's names across their spaces", read);
  if (rows.some((row) => overlaps(spaceAvailability(row), availability)))
    throw new ORPCError("CONFLICT", { message: CONFLICT_MESSAGE[kind] });
}

async function assertOwnSpaces(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "userId">,
  spaceIds: string[],
): Promise<void> {
  const members = await tx.spaceMember.findMany({
    where: { userId: actor.userId, spaceId: { in: spaceIds }, space: { deletingAt: null } },
    select: { spaceId: true },
  });
  if (members.length !== new Set(spaceIds).size) throw new ORPCError("NOT_FOUND");
}

type Joined = { spaceId: string; userId: string; allSpaces: boolean; secretId?: string | null };

/** Secrets of an item available beyond one space are the account's, so every such space reads them. */
async function settleSecret(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "userId">,
  secretId: string | null | undefined,
  home: string,
  availability: SpaceAvailability,
): Promise<void> {
  if (!secretId) return;
  const spaceId = availability.allSpaces || availability.spaceIds.length > 1 ? null : home;
  await runAsSystemInTransaction(tx, "move an item's secret with its availability", () =>
    tx.secret.updateMany({ where: { id: secretId, userId: actor.userId }, data: { spaceId } }),
  );
}

async function applyToSkill(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "userId">,
  id: string,
  home: string,
  availability: SpaceAvailability,
) {
  await tx.agentSkill.update({
    where: { id },
    data: { spaceId: home, allSpaces: availability.allSpaces },
  });
  await tx.agentSkillSpace.deleteMany({ where: { skillId: id } });
  await tx.agentSkillSpace.createMany({
    data: availability.spaceIds
      .filter((spaceId) => spaceId !== home)
      .map((spaceId) => ({ skillId: id, spaceId, userId: actor.userId })),
  });
}

async function applyToServer(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "userId">,
  server: { id: string; secretId: string | null },
  home: string,
  availability: SpaceAvailability,
) {
  await tx.mcpServer.update({
    where: { id: server.id },
    data: { spaceId: home, allSpaces: availability.allSpaces },
  });
  await tx.mcpServerSpace.deleteMany({ where: { serverId: server.id } });
  await tx.mcpServerSpace.createMany({
    data: availability.spaceIds
      .filter((spaceId) => spaceId !== home)
      .map((spaceId) => ({ serverId: server.id, spaceId, userId: actor.userId })),
  });
  await settleSecret(tx, actor, server.secretId, home, availability);
}

/** Place one of the actor's items in every space or exactly the chosen ones. */
async function place(
  tx: Prisma.TransactionClient,
  actor: Actor,
  kind: AvailabilityKind,
  item: Joined & { id: string },
  requested: SpaceAvailability,
): Promise<SpaceAvailability> {
  const spaceIds = [...new Set(requested.spaceIds)];
  const home = requested.allSpaces
    ? item.spaceId
    : spaceIds.includes(item.spaceId)
      ? item.spaceId
      : spaceIds.includes(actor.spaceId)
        ? actor.spaceId
        : spaceIds[0]!;
  const availability: SpaceAvailability = {
    allSpaces: requested.allSpaces,
    spaceIds: [home, ...spaceIds.filter((id) => id !== home)],
  };
  // The item may move to a space other than this one, which this tenant cannot write; the
  // caller checked it is the actor's.
  await runAsSystemInTransaction(tx, "change where an owner's item is available", async () => {
    if (kind === "skill") {
      const skill = await tx.agentSkill.findUniqueOrThrow({ where: { id: item.id } });
      await assertNameFreeWhereAvailable(tx, "skill", actor, skill.name, availability, skill.id);
      await applyToSkill(tx, actor, item.id, home, availability);
      return;
    }
    if (kind === "mcpServer") {
      const server = await tx.mcpServer.findUniqueOrThrow({ where: { id: item.id } });
      await assertNameFreeWhereAvailable(
        tx,
        "mcpServer",
        actor,
        server.slug,
        availability,
        server.id,
      );
      await applyToServer(tx, actor, server, home, availability);
      return;
    }
    const [skills, servers] = await Promise.all([
      tx.agentSkill.findMany({ where: { installId: item.id, userId: actor.userId } }),
      tx.mcpServer.findMany({ where: { installId: item.id, userId: actor.userId } }),
    ]);
    for (const skill of skills)
      await assertNameFreeWhereAvailable(tx, "skill", actor, skill.name, availability, skill.id);
    for (const server of servers)
      await assertNameFreeWhereAvailable(
        tx,
        "mcpServer",
        actor,
        server.slug,
        availability,
        server.id,
      );
    await tx.capabilityInstall.update({
      where: { id: item.id },
      data: { spaceId: home, allSpaces: availability.allSpaces },
    });
    await tx.capabilityInstallSpace.deleteMany({ where: { installId: item.id } });
    await tx.capabilityInstallSpace.createMany({
      data: availability.spaceIds
        .filter((spaceId) => spaceId !== home)
        .map((spaceId) => ({ installId: item.id, spaceId, userId: actor.userId })),
    });
    await settleSecret(tx, actor, item.secretId, home, availability);
    for (const skill of skills) await applyToSkill(tx, actor, skill.id, home, availability);
    for (const server of servers) await applyToServer(tx, actor, server, home, availability);
  });
  return availability;
}

/**
 * Make an item the actor can see here available in every space or exactly the chosen ones.
 * A plugin's skills and connectors follow its install. When the space an item was added in is
 * no longer chosen, it moves to the first chosen one.
 */
export async function setAvailability(
  prisma: PrismaClient,
  actor: Actor,
  input: { kind: AvailabilityKind; id: string } & SpaceAvailability,
): Promise<SpaceAvailability> {
  if (!input.spaceIds.length) throw new ORPCError("BAD_REQUEST", { message: "Choose a space" });
  return prisma.$transaction(async (tx) => {
    // Plugin parts changes hold this lock while adding parts where the install is placed.
    if (input.kind === "install") await lockOwner(tx, actor.userId, "plugin");
    await assertOwnSpaces(tx, actor, input.spaceIds);
    const visible = { id: input.id, ...availableInSpace(actor) };
    // A plugin's own skills and connectors are placed through the plugin.
    const item: (Joined & { id: string }) | null =
      input.kind === "skill"
        ? await tx.agentSkill.findFirst({ where: { ...visible, source: "user" } })
        : input.kind === "mcpServer"
          ? await tx.mcpServer.findFirst({ where: { ...visible, installId: null } })
          : await tx.capabilityInstall.findFirst({ where: visible });
    if (!item) throw new ORPCError("NOT_FOUND");
    return place(tx, actor, input.kind, item, input);
  });
}

type OwnedItem = AccountItem & { row: Joined & { id: string } };

/** The actor's own items in every space, read by owner since most live outside this space. */
async function ownItems(tx: Prisma.TransactionClient, actor: Actor): Promise<OwnedItem[]> {
  return runAsSystemInTransaction(tx, "owner's items across their spaces", async () => {
    const include = { availableIn: AVAILABILITY_SELECT };
    const [skills, servers, installs] = await Promise.all([
      tx.agentSkill.findMany({
        where: { userId: actor.userId, source: "user" },
        include,
        orderBy: { name: "asc" },
      }),
      tx.mcpServer.findMany({
        where: { userId: actor.userId, installId: null },
        include,
        orderBy: { name: "asc" },
      }),
      tx.capabilityInstall.findMany({
        where: { userId: actor.userId, kind: { in: ["plugin", "mcp", "api", "graphql"] } },
        include,
        orderBy: { name: "asc" },
      }),
    ]);
    const item = (
      kind: AvailabilityKind,
      row: Joined & { id: string; name: string } & {
        availableIn: Array<{ spaceId: string }>;
      },
    ): OwnedItem => ({
      kind,
      id: row.id,
      name: row.name,
      availability: spaceAvailability(row),
      row,
    });
    return [
      ...installs.map((row) => item("install", row)),
      ...servers.map((row) => item("mcpServer", row)),
      ...skills.map((row) => item("skill", row)),
    ];
  });
}

export async function listOwnItems(prisma: PrismaClient, actor: Actor): Promise<AccountItem[]> {
  const items = await prisma.$transaction((tx) => ownItems(tx, actor));
  return items.map(({ row: _row, ...item }) => item);
}

/**
 * Make exactly `chosen` of the actor's items available in `spaceId`, as a new space's first
 * step. Each item keeps its other spaces; one available everywhere that is left out becomes
 * available in all the actor's other spaces instead.
 */
export async function chooseForSpace(
  prisma: PrismaClient,
  actor: Actor,
  input: { spaceId: string; items: Array<{ kind: AvailabilityKind; id: string }> },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertOwnSpaces(tx, actor, [input.spaceId]);
    const memberships = await tx.spaceMember.findMany({
      where: { userId: actor.userId, space: { deletingAt: null } },
      select: { spaceId: true },
    });
    const others = memberships.map((m) => m.spaceId).filter((id) => id !== input.spaceId);
    const chosen = new Set(input.items.map((entry) => `${entry.kind}:${entry.id}`));
    for (const item of await ownItems(tx, actor)) {
      const { allSpaces, spaceIds } = item.availability;
      const here = allSpaces || spaceIds.includes(input.spaceId);
      const want = chosen.has(`${item.kind}:${item.id}`);
      if (want === here) continue;
      const next: SpaceAvailability = want
        ? { allSpaces: false, spaceIds: [...spaceIds, input.spaceId] }
        : {
            allSpaces: false,
            spaceIds: allSpaces ? others : spaceIds.filter((id) => id !== input.spaceId),
          };
      // An item only in this space has nowhere else to stay; leaving it out is not a removal.
      if (!next.spaceIds.length) continue;
      await place(tx, actor, item.kind, item.row, next);
    }
  });
}

/**
 * Before a space is deleted, move items added there that are also available elsewhere to
 * another of their owner's spaces, so deleting a space never deletes what other spaces use.
 * An item whose name is taken in the space it would move to goes with the deleted space.
 */
export async function rehomeItemsLeaving(prisma: PrismaClient, spaceId: string): Promise<void> {
  await runAsSystem("keep items other spaces use when their space is deleted", async () => {
    const include = { availableIn: AVAILABILITY_SELECT };
    const where = { spaceId, OR: [{ allSpaces: true }, { availableIn: { some: {} } }] };
    const [installs, servers, skills] = await Promise.all([
      prisma.capabilityInstall.findMany({ where, include }),
      prisma.mcpServer.findMany({ where: { ...where, installId: null }, include }),
      prisma.agentSkill.findMany({ where: { ...where, installId: null }, include }),
    ]);
    const nextHome = async (row: {
      userId: string;
      allSpaces: boolean;
      availableIn: Array<{ spaceId: string }>;
    }) => {
      const listed = row.availableIn.map((entry) => entry.spaceId).find((id) => id !== spaceId);
      if (listed || !row.allSpaces) return listed;
      const other = await prisma.spaceMember.findFirst({
        where: { userId: row.userId, spaceId: { not: spaceId }, space: { deletingAt: null } },
        orderBy: { createdAt: "asc" },
        select: { spaceId: true },
      });
      return other?.spaceId;
    };
    const move = async (
      kind: AvailabilityKind,
      row: Parameters<typeof nextHome>[0] & { id: string },
    ) => {
      const home = await nextHome(row);
      if (!home) return;
      try {
        await prisma.$transaction(async (tx) => {
          if (kind === "install") {
            await tx.capabilityInstall.update({ where: { id: row.id }, data: { spaceId: home } });
            await tx.agentSkill.updateMany({
              where: { installId: row.id },
              data: { spaceId: home },
            });
            await tx.mcpServer.updateMany({
              where: { installId: row.id },
              data: { spaceId: home },
            });
            await tx.capabilityInstallSpace.deleteMany({
              where: { installId: row.id, spaceId: home },
            });
          } else if (kind === "mcpServer") {
            await tx.mcpServer.update({ where: { id: row.id }, data: { spaceId: home } });
            await tx.mcpServerSpace.deleteMany({ where: { serverId: row.id, spaceId: home } });
          } else {
            await tx.agentSkill.update({ where: { id: row.id }, data: { spaceId: home } });
            await tx.agentSkillSpace.deleteMany({ where: { skillId: row.id, spaceId: home } });
          }
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    };
    for (const row of installs) await move("install", row);
    for (const row of servers) await move("mcpServer", row);
    for (const row of skills) await move("skill", row);
  });
}

export async function serverAvailability(
  tx: Prisma.TransactionClient,
  server: { id: string; spaceId: string; allSpaces: boolean },
): Promise<SpaceAvailability> {
  const availableIn = await tx.mcpServerSpace.findMany({
    where: { serverId: server.id },
    select: { spaceId: true },
  });
  return spaceAvailability({ ...server, availableIn });
}

/** A server's new secret goes where every space it is available in can read it. */
export async function serverSecretSpace(
  tx: Prisma.TransactionClient,
  server: { id: string; spaceId: string; allSpaces: boolean },
): Promise<string | null> {
  const { allSpaces, spaceIds } = await serverAvailability(tx, server);
  return allSpaces || spaceIds.length > 1 ? null : server.spaceId;
}
