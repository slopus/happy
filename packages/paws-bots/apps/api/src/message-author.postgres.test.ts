import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMessagePage } from "./thread-message-pages.js";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("message authors (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let target: ThreadTarget;
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `message-author-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    await system.user.update({
      where: { id: actor.userId },
      data: { name: "Ana" },
    });
    target = {
      kind: "bot",
      botId: identity.botId,
      threadId: identity.threadId,
      bot: { computer: null },
    } as ThreadTarget;
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({
      where: { userId: actor.userId },
    });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  function send(input: { text: string; replyToMessageId?: string }) {
    return runAsTenant(actor, () =>
      sendThreadMessage(
        {
          prisma,
          events: { notify } as never,
          jobs: { enqueue } as never,
          sandbox: {} as never,
        },
        actor,
        target,
        { ...input, clientNonce: randomUUID() },
      ),
    );
  }

  it("stores who sent a message and returns them on the message and its replies", async () => {
    await send({ text: "Find us a restaurant" });
    const firstRow = await system.message.findFirstOrThrow({
      where: { threadId: target.threadId, role: "user" },
      orderBy: { seq: "asc" },
    });
    expect(firstRow.authorUserId).toBe(actor.userId);

    await send({ text: "Somewhere quiet", replyToMessageId: firstRow.id });
    const created = await system.event.findMany({
      where: { threadId: target.threadId, type: "thread.message.created" },
      orderBy: { seq: "asc" },
    });
    const ana = { id: actor.userId, name: "Ana" };
    expect(created.map((event) => (event.payload as { author?: unknown }).author)).toEqual([
      ana,
      ana,
    ]);
    const reply = created[1]?.payload as { replyPreview?: { author?: unknown } } | undefined;
    expect(reply?.replyPreview?.author).toEqual(ana);

    const page = await runAsTenant(actor, () =>
      loadMessagePage(prisma, target.threadId, undefined, 10),
    );
    const users = page.messages.filter((message) => message.role === "user");
    expect(users.map((message) => message.author)).toEqual([ana, ana]);
    expect(users[1]?.replyPreview?.author).toEqual(ana);
  });
});
