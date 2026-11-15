import { randomBytes } from "node:crypto";
import type { InboundEmail } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEmailTrigger,
  botEmailAddress,
  botEmailAddresses,
  claimBotEmailAddress,
} from "./bot-email-address.js";
import { receiveBotEmail } from "./email-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const DOMAIN = "bots.test";

describePostgres("bot email addresses (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  const names: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let sequence = 0;

  const name = (label: string) => {
    const value = `${label}-${suffix}`.toLowerCase();
    names.push(value);
    return value;
  };

  async function signup(email: string) {
    const userId = `bot-email-${++sequence}-${suffix}`;
    users.push(userId);
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: true } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId };
  }

  async function bot(owner: { userId: string; spaceId: string }) {
    const created = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: "Scout", color: "blue" },
    });
    await system.thread.create({
      data: { spaceId: owner.spaceId, botId: created.id, userId: owner.userId },
    });
    return created;
  }

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.botEmailAddress.deleteMany({ where: { name: { in: names } } });
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("gives each name to one bot for good", async () => {
    const owner = await signup(`ada-${suffix}@example.test`);
    const first = await bot(owner);
    const second = await bot(owner);
    const scout = name("scout");

    await expect(botEmailAddress(system, DOMAIN, first.id)).resolves.toEqual({
      domain: DOMAIN,
      address: null,
    });
    await expect(botEmailAddress(system, undefined, first.id)).resolves.toBeNull();
    const [a, b] = await Promise.allSettled([
      claimBotEmailAddress(system, DOMAIN, first.id, scout),
      claimBotEmailAddress(system, DOMAIN, first.id, scout),
    ]);
    expect(a).toMatchObject({ status: "fulfilled", value: { address: `${scout}@${DOMAIN}` } });
    expect(b).toMatchObject({ status: "fulfilled" });
    await expect(claimBotEmailAddress(system, DOMAIN, second.id, scout)).rejects.toThrow(
      "That address isn't available",
    );
    await expect(claimBotEmailAddress(system, DOMAIN, first.id, name("other"))).rejects.toThrow(
      "already has an address",
    );
    await expect(assertEmailTrigger(system, DOMAIN, second.id)).rejects.toThrow(
      "Choose an email address",
    );
    await expect(assertEmailTrigger(system, DOMAIN, first.id)).resolves.toBeUndefined();

    const someoneElse = await signup(`eve-${suffix}@example.test`);
    const theirs = await bot(someoneElse);
    await claimBotEmailAddress(system, DOMAIN, theirs.id, name("theirs"));
    await expect(botEmailAddresses(system, DOMAIN, owner)).resolves.toEqual({
      domain: DOMAIN,
      addresses: [{ botId: first.id, botName: "Scout", address: `${scout}@${DOMAIN}` }],
    });
    await system.bot.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    await expect(botEmailAddresses(system, DOMAIN, owner)).resolves.toEqual({
      domain: DOMAIN,
      addresses: [],
    });

    await system.bot.delete({ where: { id: first.id } });
    await expect(claimBotEmailAddress(system, DOMAIN, second.id, scout)).rejects.toThrow(
      "That address isn't available",
    );
  });

  it("routes mail to the addressed bot's matching active routines", async () => {
    const owner = await signup(`grace-${suffix}@example.test`);
    const target = await bot(owner);
    const other = await bot(owner);
    const helper = name("helper");
    await claimBotEmailAddress(system, DOMAIN, target.id, helper);
    // Another member's routine on the owner's bot: mail runs as the owner, so it never starts.
    const member = await signup(`lin-${suffix}@example.test`);
    const routine = (
      botId: string,
      label: string,
      emailSenders: string | null,
      active = true,
      userId = owner.userId,
    ) =>
      system.routine.create({
        data: {
          spaceId: owner.spaceId,
          botId,
          userId,
          name: label,
          prompt: `Do ${label}.`,
          crons: emailSenders ? [] : ["0 8 * * *"],
          active,
          emailSenders,
        },
      });
    await routine(target.id, "mine", "owner");
    await routine(target.id, "team", "domain");
    await routine(target.id, "paused", "owner", false);
    await routine(target.id, "scheduled", null);
    await routine(other.id, "elsewhere", "owner");
    await routine(target.id, "member's", "domain", true, member.userId);

    const sendUserMessage = vi.fn(async (_input: unknown) => ({
      messageId: "m",
      runId: "r",
      seq: 1,
    }));
    const message: InboundEmail = {
      key: `<${suffix}@example.test>`,
      from: { address: `colleague-${suffix}@example.test`, name: "" },
      authenticated: true,
      unauthenticatedReason: null,
      temporaryFailure: false,
      to: [`${helper}@${DOMAIN}`],
      cc: [],
      subject: "Hello",
      date: null,
      text: "Hi",
      automated: false,
      attachments: [],
      messageId: `<${suffix}@example.test>`,
      references: [],
    };
    const result = await runAsSystem("test inbound email", () =>
      receiveBotEmail(
        {
          prisma,
          events: { sendUserMessage, notify: vi.fn(async () => undefined) },
          jobs: { enqueue: vi.fn(async () => undefined) },
          domain: DOMAIN,
          secret: "unused",
          readEmail: async () => message,
        },
        `${helper}@${DOMAIN}`,
        new Uint8Array(),
      ),
    );

    expect(result).toMatchObject({ ok: true, runId: "r" });
    const prompt = (sendUserMessage.mock.calls[0]?.[0] as unknown as { prompt: string } | undefined)
      ?.prompt;
    expect(prompt).toContain('Run routine "team"');
    for (const skipped of ["mine", "paused", "scheduled", "elsewhere", "member's"]) {
      expect(prompt).not.toContain(`Run routine "${skipped}"`);
    }
    const saved = await system.botEmailMessage.findMany({ where: { botId: target.id } });
    expect(saved).toMatchObject([{ verified: true, subject: "Hello", spaceId: owner.spaceId }]);
  });

  it("tells the owner once a day when mail from their address fails the check", async () => {
    const email = `linus-${suffix}@example.test`;
    const owner = await signup(email);
    const target = await bot(owner);
    const helper = name("notice");
    await claimBotEmailAddress(system, DOMAIN, target.id, helper);
    await system.routine.create({
      data: {
        spaceId: owner.spaceId,
        botId: target.id,
        userId: owner.userId,
        name: "inbox",
        prompt: "Do inbox.",
        crons: [],
        active: true,
        emailSenders: "owner",
      },
    });
    const unverified = (from: string): InboundEmail => ({
      key: `<${from}-${suffix}>`,
      from: { address: from, name: "" },
      authenticated: false,
      unauthenticatedReason: "no valid signature from the sender's domain",
      temporaryFailure: false,
      to: [`${helper}@${DOMAIN}`],
      cc: [],
      subject: "Hi",
      date: null,
      text: "Your code is 123456",
      automated: false,
      attachments: [],
      messageId: null,
      references: [],
    });
    const notify = vi.fn(async () => undefined);
    const deliver = (from: string) =>
      runAsSystem("test inbound email", () =>
        receiveBotEmail(
          {
            prisma,
            events: { sendUserMessage: vi.fn(), notify },
            jobs: { enqueue: vi.fn(async () => undefined) },
            domain: DOMAIN,
            secret: "unused",
            readEmail: async () => unverified(from),
          },
          `${helper}@${DOMAIN}`,
          new Uint8Array(),
        ),
      );

    await Promise.all([deliver(email), deliver(email)]);
    await deliver(`stranger-${suffix}@example.test`);

    const thread = await system.thread.findUniqueOrThrow({ where: { botId: target.id } });
    const notes = await system.message.findMany({
      where: { threadId: thread.id, role: "system" },
    });
    expect(notes).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(
      system.threadRead.count({ where: { threadId: thread.id, unread: true } }),
    ).resolves.toBeGreaterThan(0);
    // Both copies of the owner's message are one inbox entry; the stranger's is another.
    // Sorted after reading: the sender is stored encrypted when content encryption is on.
    const saved = await system.botEmailMessage.findMany({ where: { botId: target.id } });
    saved.sort((a, b) => a.fromAddress.localeCompare(b.fromAddress));
    expect(saved.map((row) => [row.fromAddress, row.verified, row.text])).toEqual([
      [email, false, "Your code is 123456"],
      [`stranger-${suffix}@example.test`, false, "Your code is 123456"],
    ]);
  });
});
