import { randomUUID } from "node:crypto";
import { skillCreateFromTool } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, itemSecretIn, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import {
  chooseForSpace,
  listOwnItems,
  rehomeItemsLeaving,
  setAvailability,
} from "./availability.js";

// The runtime login, so row-level security applies exactly as it does in a deployment.
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("items available across a user's spaces (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `avail-org-${suffix}`;
  const owner = `avail-owner-${suffix}`;
  const teammate = `avail-mate-${suffix}`;
  const work = `avail-work-${suffix}`;
  const home = `avail-home-${suffix}`;
  const theirs = `avail-theirs-${suffix}`;
  const actorIn = (spaceId: string, userId = owner): Actor => ({
    spaceId,
    userId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });
  const skills = () => createAgentSkillsService(prisma);
  const listedNames = async (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await skills().list(actor)).filter((s) => s.source === "user").map((s) => s.name),
    );
  /** Every agent_skills row the database itself lets this tenant read, with no app filter. */
  const visibleRows = async (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await prisma.agentSkill.findMany({ select: { name: true, userId: true } })).map(
        (row) => `${row.userId === owner ? "owner" : "mate"}:${row.name}`,
      ),
    );
  const join = async (userId: string, spaceId: string) =>
    prisma.spaceMember.create({
      data: { id: `${userId}-${spaceId}`, organizationId, spaceId, userId, createdAt: new Date() },
    });
  const createSpace = async (id: string, userIds: string[]) => {
    await prisma.space.create({ data: { id, organizationId, name: id } });
    for (const userId of userIds) await join(userId, id);
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await runAsSystem("availability fixture", async () => {
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Availability",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      for (const userId of [owner, teammate]) {
        await prisma.user.create({
          data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
        });
        await prisma.member.create({
          data: { id: `${userId}-m`, organizationId, userId, role: "owner", createdAt: new Date() },
        });
      }
      // A shared team space, the owner's private one, and the teammate's own.
      await createSpace(work, [owner, teammate]);
      await createSpace(home, [owner]);
      await createSpace(theirs, [teammate]);
    });
  });
  afterAll(async () => {
    if (prisma) {
      await runAsSystem("availability fixture", async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: { in: [owner, teammate] } } });
      });
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("makes what the user adds available in all their spaces, and to nobody else", async () => {
    await runAsTenant(actorIn(work), () =>
      skills().create(actorIn(work), { name: "weekly-review", description: "Review the week" }),
    );
    expect(await listedNames(actorIn(work))).toContain("weekly-review");
    expect(await listedNames(actorIn(home))).toContain("weekly-review");
    // The teammate shares the space, but the skill is the owner's.
    expect(await listedNames(actorIn(work, teammate))).not.toContain("weekly-review");
    // Available everywhere must not mean available to anyone: the database refuses it too.
    expect(await visibleRows(actorIn(theirs, teammate))).not.toContain("owner:weekly-review");
  });

  it("keeps a skill limited to one space out of the others, down to the database", async () => {
    const created = await runAsTenant(actorIn(work), () =>
      skills().create(actorIn(work), { name: "client-notes", description: "Notes on the client" }),
    );
    await runAsTenant(actorIn(work), () =>
      setAvailability(prisma, actorIn(work), {
        kind: "skill",
        id: created.id,
        allSpaces: false,
        spaceIds: [work],
      }),
    );
    expect(await listedNames(actorIn(work))).toContain("client-notes");
    expect(await listedNames(actorIn(home))).not.toContain("client-notes");
    expect(await visibleRows(actorIn(home))).not.toContain("owner:client-notes");
    // From the other space the item cannot be changed or reached by id either.
    await expect(
      runAsTenant(actorIn(home), () =>
        setAvailability(prisma, actorIn(home), {
          kind: "skill",
          id: created.id,
          allSpaces: true,
          spaceIds: [home],
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps what a bot writes in the space it wrote it in", async () => {
    const result = await runAsTenant(actorIn(home), () =>
      skillCreateFromTool(prisma, actorIn(home), {
        name: "home-routine",
        description: "Private routine",
        body: "Steps",
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(await listedNames(actorIn(home))).toContain("home-routine");
    expect(await listedNames(actorIn(work))).not.toContain("home-routine");
    expect(await visibleRows(actorIn(work))).not.toContain("owner:home-routine");
  });

  it("refuses to make two same-named skills visible together", async () => {
    // "home-routine" lives only in home; one available everywhere would meet it there.
    await expect(
      runAsTenant(actorIn(work), () =>
        skills().create(actorIn(work), { name: "home-routine", description: "Another one" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets only one of two spaces claim a name at the same moment", async () => {
    const results = await Promise.allSettled(
      [work, home].map((spaceId) =>
        runAsTenant(actorIn(spaceId), () =>
          skills().create(actorIn(spaceId), { name: "race-routine", description: "Racing" }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
  });

  it("reaches spaces created later, and a new space can leave items out", async () => {
    const later = `avail-later-${suffix}`;
    await runAsSystem("availability fixture", () => createSpace(later, [owner]));
    expect(await listedNames(actorIn(later))).toContain("weekly-review");
    expect(await listedNames(actorIn(later))).not.toContain("client-notes");

    const items = await runAsTenant(actorIn(later), () => listOwnItems(prisma, actorIn(later)));
    const weekly = items.find((item) => item.name === "weekly-review")!;
    const notes = items.find((item) => item.name === "client-notes")!;
    expect(weekly.availability.allSpaces).toBe(true);
    // Choose client-notes for the new space and leave weekly-review out.
    await runAsTenant(actorIn(later), () =>
      chooseForSpace(prisma, actorIn(later), {
        spaceId: later,
        items: [{ kind: "skill", id: notes.id }],
      }),
    );
    expect(await listedNames(actorIn(later))).toEqual(expect.arrayContaining(["client-notes"]));
    expect(await listedNames(actorIn(later))).not.toContain("weekly-review");
    // Leaving it out of one space keeps it everywhere it was.
    expect(await listedNames(actorIn(work))).toContain("weekly-review");
    expect(await listedNames(actorIn(home))).toContain("weekly-review");
  });

  it("gives a server's secret to every space the server reaches", async () => {
    const serverId = `avail-server-${suffix}`;
    const secretId = `avail-secret-${suffix}`;
    await runAsSystem("availability fixture", async () => {
      await prisma.secret.create({
        data: { id: secretId, userId: owner, spaceId: work, kind: "mcp", ciphertext: "c" },
      });
      await prisma.mcpServer.create({
        data: {
          id: serverId,
          spaceId: work,
          userId: owner,
          slug: `docs-${suffix}`,
          name: "Docs",
          transport: "streamable_http",
          endpoint: "https://tools.example.test/mcp",
          secretId,
        },
      });
    });
    const readSecret = (spaceId: string) =>
      runAsTenant(actorIn(spaceId), () =>
        prisma.secret.findFirst({ where: { id: secretId, ...itemSecretIn(actorIn(spaceId)) } }),
      );
    expect(await readSecret(home)).toBeNull();
    await runAsTenant(actorIn(work), () =>
      setAvailability(prisma, actorIn(work), {
        kind: "mcpServer",
        id: serverId,
        allSpaces: false,
        spaceIds: [work, home],
      }),
    );
    expect(await readSecret(home)).not.toBeNull();
    expect(
      await runAsTenant(actorIn(theirs, teammate), () =>
        prisma.mcpServer.findMany({ where: { id: serverId } }),
      ),
    ).toEqual([]);
  });

  it("keeps items other spaces use when the space they were added in is deleted", async () => {
    const doomed = `avail-doomed-${suffix}`;
    await runAsSystem("availability fixture", () => createSpace(doomed, [owner]));
    await runAsTenant(actorIn(doomed), () =>
      skills().create(actorIn(doomed), { name: "survivor", description: "Used elsewhere" }),
    );
    await rehomeItemsLeaving(prisma, doomed);
    await runAsSystem("availability fixture", () => prisma.space.delete({ where: { id: doomed } }));
    expect(await listedNames(actorIn(work))).toContain("survivor");
  });
});
