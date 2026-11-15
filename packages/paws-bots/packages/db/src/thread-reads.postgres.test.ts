import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createThreadMessage } from "./messages.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { leaveSpace } from "./space-members.js";
import {
  clearThreadReads,
  markThreadReadFor,
  markThreadUnreadFromFor,
  setThreadSnoozeFor,
  setThreadUnreadFor,
} from "./thread-reads.js";
import { countUnreadInboxChats } from "./unread-inbox-chats.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

// Ada owns a Space and shared it with Bea. Otto has a Space of his own and nothing to do with it.
describePostgres("each member's own read state (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ada = `reads-ada-${suffix}`;
  const bea = `reads-bea-${suffix}`;
  const otto = `reads-otto-${suffix}`;
  const organization = `reads-org-${suffix}`;
  const ottoOrganization = `reads-otto-org-${suffix}`;
  const beaOrganization = `reads-bea-org-${suffix}`;
  const space = `reads-space-${suffix}`;
  const ottoSpace = `reads-otto-space-${suffix}`;
  const beaSpace = `reads-bea-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let threadId = "";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const fixture = asSystem(prisma);
    const now = new Date();
    for (const id of [ada, bea, otto]) {
      await fixture.user.create({
        data: { id, name: id.split("-")[1]!, email: `${id}@example.test`, emailVerified: false },
      });
    }
    for (const [id, owner, spaceId] of [
      [organization, ada, space],
      [ottoOrganization, otto, ottoSpace],
      // Bea has her own, like everyone; Ada's Space is shared with her as a guest.
      [beaOrganization, bea, beaSpace],
    ] as const) {
      await fixture.organization.create({ data: { id, name: "Reads", slug: id, createdAt: now } });
      await fixture.member.create({
        data: {
          id: randomUUID(),
          organizationId: id,
          userId: owner,
          role: "owner",
          createdAt: now,
        },
      });
      await fixture.space.create({
        // Bea's own organization is live: its default Space stands.
        data: { id: spaceId, organizationId: id, name: "Reads", isDefault: spaceId === beaSpace },
      });
      await fixture.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId: id,
          spaceId,
          userId: owner,
          role: "owner",
          createdAt: now,
        },
      });
    }
    await fixture.member.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        userId: bea,
        role: "guest",
        createdAt: now,
      },
    });
    await fixture.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        spaceId: space,
        userId: bea,
        role: "member",
        createdAt: new Date(now.getTime() + 1),
      },
    });
    const bot = await fixture.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Planner",
        color: "blue",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    threadId = bot.thread!.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).space.deleteMany({
      where: { id: { in: [space, ottoSpace, beaSpace] } },
    });
    await asSystem(prisma).organization.deleteMany({
      where: { id: { in: [organization, ottoOrganization, beaOrganization] } },
    });
    await asSystem(prisma).user.deleteMany({ where: { id: { in: [ada, bea, otto] } } });
    await close();
  });

  const reader = (userId: string) => ({ threadId, spaceId: space, userId });
  const as = <T>(userId: string, fn: () => Promise<T>) =>
    runAsTenant({ spaceId: space, userId }, fn);

  /** What `userId` sees for the chat, through their own tenant context. */
  function stateOf(userId: string) {
    return as(userId, () =>
      prisma.threadRead.findFirst({
        where: { threadId, userId },
        select: { unread: true, lastReadSeq: true },
      }),
    );
  }

  const unread = async (userId: string) => (await stateOf(userId))?.unread ?? false;

  function post(author: string, input: { role: "user" | "bot"; text: string }) {
    return as(author, () =>
      createThreadMessage(prisma, {
        threadId,
        role: input.role,
        blocks: [{ kind: "text", text: input.text }],
        ...(input.role === "user" ? { authorUserId: author } : {}),
      }),
    );
  }

  it("leaves a member's message unread for the other member, not its author or an outsider", async () => {
    await post(ada, { role: "user", text: "Can you plan dinner for Saturday?" });
    expect(await unread(bea)).toBe(true);
    expect(await unread(ada)).toBe(false);
    await expect(asSystem(prisma).threadRead.count({ where: { userId: otto } })).resolves.toBe(0);
    await expect(countUnreadInboxChats(prisma, { spaceId: space, userId: bea })).resolves.toBe(1);
    await expect(countUnreadInboxChats(prisma, { spaceId: space, userId: ada })).resolves.toBe(0);
    await expect(countUnreadInboxChats(prisma, { spaceId: ottoSpace, userId: otto })).resolves.toBe(
      0,
    );
  });

  it("marks a reply unread for both, and one reading it leaves the other unread", async () => {
    await post(ada, { role: "bot", text: "Pasta, then a walk." });
    expect(await unread(ada)).toBe(true);
    expect(await unread(bea)).toBe(true);

    // Ada had read up to her own message (seq 0); Bea had read nothing.
    await expect(as(ada, () => markThreadReadFor(prisma, reader(ada)))).resolves.toBe(0);
    expect(await stateOf(ada)).toEqual({ unread: false, lastReadSeq: 1 });
    expect(await unread(bea)).toBe(true);
    await expect(as(ada, () => markThreadReadFor(prisma, reader(ada)))).resolves.toBeNull();

    await expect(as(bea, () => markThreadReadFor(prisma, reader(bea)))).resolves.toBe(-1);
    expect(await stateOf(bea)).toEqual({ unread: false, lastReadSeq: 1 });
  });

  it("keeps each person's rows to themselves", async () => {
    const seen = await as(bea, () =>
      prisma.threadRead.findMany({ where: { threadId }, select: { userId: true } }),
    );
    expect(seen).toEqual([{ userId: bea }]);
    const outsider = await runAsTenant({ spaceId: ottoSpace, userId: otto }, () =>
      prisma.threadRead.findMany({ where: { threadId } }),
    );
    expect(outsider).toEqual([]);
  });

  it("marks a chat unread for one person only", async () => {
    await expect(
      as(bea, () => markThreadUnreadFromFor(prisma, reader(bea), "no-such-message")),
    ).resolves.toBe(false);
    const [first] = await asSystem(prisma).message.findMany({
      where: { threadId },
      orderBy: { seq: "asc" },
      take: 1,
    });
    await as(bea, () => markThreadUnreadFromFor(prisma, reader(bea), first!.id));
    expect(await stateOf(bea)).toEqual({ unread: true, lastReadSeq: -1 });
    expect(await unread(ada)).toBe(false);

    await as(ada, () => setThreadUnreadFor(prisma, reader(ada), true));
    expect(await stateOf(ada)).toEqual({ unread: true, lastReadSeq: 1 });
    await as(ada, () => setThreadUnreadFor(prisma, reader(ada), false));
    expect(await unread(ada)).toBe(false);
    expect(await unread(bea)).toBe(true);
  });

  it("waits for a Mark as Unread from another tab instead of overwriting it", async () => {
    await as(ada, () => markThreadReadFor(prisma, reader(ada)));
    let hold!: () => void;
    const held = new Promise<void>((resolve) => {
      hold = resolve;
    });
    let marked!: () => void;
    const markedUnread = new Promise<void>((resolve) => {
      marked = resolve;
    });
    // One tab marks the chat unread from its first message and has not committed yet.
    const otherTab = as(ada, () =>
      prisma.$transaction(async (tx) => {
        await tx.threadRead.update({
          where: { threadId_userId: { threadId, userId: ada } },
          data: { unread: true, lastReadSeq: -1 },
        });
        marked();
        await held;
      }),
    );
    await markedUnread;
    // Another reads it meanwhile: the read waits for that row, then sees the mark.
    const read = as(ada, () => markThreadReadFor(prisma, reader(ada)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    hold();
    await otherTab;
    await expect(read).resolves.toBe(-1);
  });

  it("snoozes a chat for one person, until they open it after it wakes", async () => {
    const snoozeOf = async (userId: string) =>
      (
        await as(userId, () =>
          prisma.threadRead.findFirst({
            where: { threadId, userId },
            select: { snoozedUntil: true },
          }),
        )
      )?.snoozedUntil ?? null;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await as(bea, () => setThreadSnoozeFor(prisma, reader(bea), tomorrow));
    expect(await snoozeOf(bea)).toEqual(tomorrow);
    expect(await snoozeOf(ada)).toBeNull();

    // Reading while still snoozed keeps the snooze.
    await as(bea, () => markThreadReadFor(prisma, reader(bea)));
    expect(await snoozeOf(bea)).toEqual(tomorrow);

    // Once it has woken, opening the chat ends it, even with nothing new to read.
    await asSystem(prisma).threadRead.update({
      where: { threadId_userId: { threadId, userId: bea } },
      data: { snoozedUntil: new Date(Date.now() - 1000) },
    });
    await as(bea, () => markThreadReadFor(prisma, reader(bea)));
    expect(await snoozeOf(bea)).toBeNull();

    // Clearing the chat keeps a snooze; unsnoozing ends it.
    await as(bea, () => setThreadSnoozeFor(prisma, reader(bea), tomorrow));
    await as(ada, () => prisma.$transaction((tx) => clearThreadReads(tx, threadId)));
    expect(await snoozeOf(bea)).toEqual(tomorrow);
    expect(await unread(bea)).toBe(false);
    await as(bea, () => setThreadSnoozeFor(prisma, reader(bea), null));
    expect(await snoozeOf(bea)).toBeNull();
  });

  it("clears every member's state with the chat", async () => {
    await as(ada, () => prisma.$transaction((tx) => clearThreadReads(tx, threadId)));
    await expect(asSystem(prisma).threadRead.count({ where: { threadId } })).resolves.toBe(0);
  });

  it("deletes a member's read state when they leave, and stops marking chats for them", async () => {
    await post(ada, { role: "bot", text: "Shopping list is ready." });
    expect(await unread(bea)).toBe(true);
    await leaveSpace(prisma, { spaceId: space, userId: bea });
    await expect(asSystem(prisma).threadRead.count({ where: { userId: bea } })).resolves.toBe(0);
    expect(await unread(ada)).toBe(true);

    await post(ada, { role: "bot", text: "And the recipe." });
    await expect(asSystem(prisma).threadRead.count({ where: { userId: bea } })).resolves.toBe(0);
  });
});
