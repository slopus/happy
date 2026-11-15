import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createExternalConversationRepos } from "./external-conversations.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { createSpaceForMember } from "./spaces.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? databaseUrl;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** Rows Postgres returned for one statement. */
interface SqlRead {
  text: string;
  values: unknown[];
  rowCount: number;
  rows: unknown[];
  fields: string[];
}

const MESSAGE_FROM = /\bfrom\s+(?:"public"\s*\.\s*)?"?messages"?\b/i;
const EXTERNAL_FROM = /\bfrom\s+(?:"public"\s*\.\s*)?"?external_messages"?\b/i;

function sqlText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "text" in input && typeof input.text === "string") {
    return input.text;
  }
  return "";
}

function sqlValues(args: unknown[]): unknown[] {
  const [first, second] = args;
  if (Array.isArray(second)) return second;
  if (first && typeof first === "object" && "values" in first && Array.isArray(first.values)) {
    return first.values;
  }
  return [];
}

/** Sum of rows actually sent to the app, not rows Prisma later drops in memory. */
function trackReads(pool: Pool, table: RegExp): SqlRead[] {
  const reads: SqlRead[] = [];
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const result = (original as (...inner: unknown[]) => unknown)(...args);
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<QueryResult>).then((queryResult) => {
      const text = sqlText(args[0]);
      if (/^\s*select\b/i.test(text) && table.test(text)) {
        reads.push({
          text,
          values: sqlValues(args),
          rowCount: queryResult.rowCount ?? 0,
          rows: queryResult.rows ?? [],
          fields: queryResult.fields?.map((field) => field.name) ?? [],
        });
      }
      return queryResult;
    });
  }) as Pool["query"];
  return reads;
}

interface Actor {
  userId: string;
  spaceId: string;
  email: string;
  isDeploymentOwner: boolean;
}

interface SenderRow {
  senderId: string;
  senderName: string;
  senderIsBot: boolean;
}

interface ExpectedConversation {
  spaceId: string;
  botId: string;
  provider: string;
  displayName: string;
  participantNames: string[];
  teamChatAmbientEnabled: boolean | null;
  teamChatRules: string | null;
  automatedSenderPolicies: Record<string, { name: string; mode: "ignore" }>;
  automatedSenders: Array<{ id: string; name: string }>;
  preview: string;
  unread: boolean;
  updatedAt: string;
}

const THREAD_COUNT = 4;
const A1_THREAD_MESSAGES = 40;
const B1_THREAD_MESSAGES = 40;
const A2_THREAD_MESSAGES = 5;
const A1_BOT_MESSAGES = 150;
const A2_BOT_MESSAGES = 30;
const A1_HUMAN_MESSAGES = 20;
const BOT_SENDER_WINDOW = 100;
/** What a 100-row window returns for this seed: 100 of A1's 150, plus all 30 of A2. */
const EXTERNAL_ROW_BOUND = Math.min(A1_BOT_MESSAGES, BOT_SENDER_WINDOW) + A2_BOT_MESSAGES;

const STEADY_POLICY = { "sender-steady": { name: "Steady", mode: "ignore" as const } };

describePostgres("team-chat conversation previews (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = `${Date.now()}`;
  const ownerAddress = `+1558${stamp.slice(-7)}`;
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;
  let userId = "";
  let spaceA = "";
  let spaceB = "";
  let actorA: Actor;
  let messageReads: SqlRead[] = [];
  let externalReads: SqlRead[] = [];
  let expected: ExpectedConversation[] = [];
  let messageClock = Date.UTC(2026, 5, 1);
  let externalClock = Date.UTC(2026, 1, 1);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    const ownerDb = createDb(migrationUrl!);
    prisma = db.prisma;
    owner = ownerDb.prisma;
    messageReads = trackReads(db.pool, MESSAGE_FROM);
    externalReads = trackReads(db.pool, EXTERNAL_FROM);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
      await ownerDb.prisma.$disconnect();
      await ownerDb.pool.end();
    };
    const provisioned = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address: ownerAddress }, signup),
    );
    userId = provisioned.userId;
    spaceA = provisioned.spaceId;
    actorA = {
      userId,
      spaceId: spaceA,
      email: "external-preview@example.com",
      isDeploymentOwner: false,
    };
    const other = await runAsSystem("test fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: spaceA,
        userId,
        name: "Other space",
      }),
    );
    spaceB = other.id;
    const actorB = { ...actorA, spaceId: spaceB };
    const botA = await runAsTenant(actorA, () =>
      createRepos(prisma).createBot(actorA, {
        name: "Bridge A",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    const botB = await runAsTenant(actorB, () =>
      createRepos(prisma).createBot(actorB, {
        name: "Bridge B",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );

    const a1Senders = botSendersA1();
    const a2Senders = botSendersA2();
    if (a1Senders.length !== A1_BOT_MESSAGES) {
      throw new Error(`A1 bot seed is ${a1Senders.length}, expected ${A1_BOT_MESSAGES}`);
    }
    if (a2Senders.length !== A2_BOT_MESSAGES) {
      throw new Error(`A2 bot seed is ${a2Senders.length}, expected ${A2_BOT_MESSAGES}`);
    }

    expected = [
      await seedConversation({
        spaceId: spaceA,
        botId: botA.id,
        key: `a1-${stamp}`,
        displayName: "launch-a",
        participantNames: ["Ada"],
        teamChatAmbientEnabled: true,
        teamChatRules: "Ping on dates",
        automatedSenderPolicies: STEADY_POLICY,
        updatedAt: new Date("2026-08-04T00:00:00.000Z"),
        unread: true,
        messageCount: A1_THREAD_MESSAGES,
        previewLabel: "A1",
        externalRows: [
          ...a1Senders,
          ...Array.from({ length: A1_HUMAN_MESSAGES }, () => ({
            senderId: "human",
            senderName: "Pat",
            senderIsBot: false,
          })),
        ],
        automatedSenders: [
          { id: "sender-rename", name: "Rename Oldest" },
          { id: "sender-steady", name: "Steady" },
        ],
      }),
      await seedConversation({
        spaceId: spaceB,
        botId: botB.id,
        key: `b1-${stamp}`,
        displayName: "launch-b",
        participantNames: ["Bea"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
        updatedAt: new Date("2026-08-03T00:00:00.000Z"),
        unread: false,
        messageCount: B1_THREAD_MESSAGES,
        previewLabel: "B1",
        externalRows: [],
        automatedSenders: [],
      }),
      await seedConversation({
        spaceId: spaceA,
        botId: botA.id,
        key: `a2-${stamp}`,
        displayName: "launch-a2",
        participantNames: ["Cy"],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        unread: true,
        messageCount: A2_THREAD_MESSAGES,
        previewLabel: "A2",
        externalRows: a2Senders,
        automatedSenders: [
          { id: "sender-a", name: "Ada Oldest" },
          { id: "sender-b", name: "Bea" },
        ],
      }),
      await seedConversation({
        spaceId: spaceB,
        botId: botB.id,
        key: `b2-${stamp}`,
        displayName: "launch-b2",
        participantNames: [],
        teamChatAmbientEnabled: null,
        teamChatRules: null,
        automatedSenderPolicies: {},
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        unread: false,
        messageCount: 0,
        previewLabel: "B2",
        externalRows: [],
        automatedSenders: [],
      }),
    ];
  });

  afterAll(async () => {
    if (prisma && userId) {
      await asSystem(prisma).messagingIdentity.deleteMany({
        where: { provider, address: ownerAddress },
      });
      if (spaceA) {
        await asSystem(prisma).organization.deleteMany({ where: { id: spaceA } });
      }
      await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    }
    await close?.();
  });

  function nextMessageAt(): Date {
    const at = new Date(messageClock);
    messageClock += 1000;
    return at;
  }

  function nextExternalAt(): Date {
    const at = new Date(externalClock);
    externalClock += 1000;
    return at;
  }

  function botSendersA1(): SenderRow[] {
    const rows: SenderRow[] = [];
    for (let index = 0; index < 50; index += 1) {
      rows.push({ senderId: "sender-old", senderName: "Ancient", senderIsBot: true });
    }
    rows.push({ senderId: "sender-rename", senderName: "Rename Oldest", senderIsBot: true });
    while (rows.length < 148) {
      const rename = rows.length % 2 === 1;
      rows.push({
        senderId: rename ? "sender-rename" : "sender-steady",
        senderName: rename ? "Rename Mid" : "Steady",
        senderIsBot: true,
      });
    }
    rows.push({ senderId: "sender-steady", senderName: "Steady", senderIsBot: true });
    rows.push({ senderId: "sender-rename", senderName: "Rename Newest", senderIsBot: true });
    return rows;
  }

  function botSendersA2(): SenderRow[] {
    const rows: SenderRow[] = [
      { senderId: "sender-a", senderName: "Ada Oldest", senderIsBot: true },
    ];
    while (rows.length < A2_BOT_MESSAGES - 1) {
      rows.push({ senderId: "sender-b", senderName: "Bea", senderIsBot: true });
    }
    rows.push({ senderId: "sender-a", senderName: "Ada Newest", senderIsBot: true });
    return rows;
  }

  async function seedConversation(input: {
    spaceId: string;
    botId: string;
    key: string;
    displayName: string;
    participantNames: string[];
    teamChatAmbientEnabled: boolean | null;
    teamChatRules: string | null;
    automatedSenderPolicies: ExpectedConversation["automatedSenderPolicies"];
    updatedAt: Date;
    unread: boolean;
    messageCount: number;
    previewLabel: string;
    externalRows: SenderRow[];
    automatedSenders: ExpectedConversation["automatedSenders"];
  }): Promise<ExpectedConversation> {
    const created = await runAsSystem("test fixture", () =>
      owner.externalConversation.create({
        data: {
          provider: "slack",
          workspaceId: "W",
          externalKey: input.key,
          conversationId: input.key,
          displayName: input.displayName,
          participantNames: input.participantNames,
          teamChatAmbientEnabled: input.teamChatAmbientEnabled,
          teamChatRules: input.teamChatRules,
          automatedSenderPolicies: input.automatedSenderPolicies,
          spaceId: input.spaceId,
          botId: input.botId,
          userId,
          updatedAt: input.updatedAt,
          thread: {
            create: {
              spaceId: input.spaceId,
              userId,
              ...(input.unread
                ? { reads: { create: { spaceId: input.spaceId, userId, unread: true } } }
                : {}),
            },
          },
        },
        include: { thread: { select: { id: true } } },
      }),
    );
    if (!created.thread) throw new Error(`conversation ${input.key} has no thread`);
    const threadId = created.thread.id;
    await runAsSystem(
      "test fixture",
      () =>
        owner.$executeRaw`UPDATE external_conversations SET "updatedAt" = ${input.updatedAt} WHERE id = ${created.id}`,
    );
    if (input.messageCount > 0) {
      await runAsSystem("test fixture", () =>
        owner.message.createMany({
          data: Array.from({ length: input.messageCount }, (_, seq) => ({
            id: `${threadId}-${seq}`,
            threadId,
            seq,
            role: "user",
            blocks: [{ kind: "text", text: `${input.previewLabel} ${seq}` }],
            createdAt: nextMessageAt(),
          })),
        }),
      );
      await runAsSystem("test fixture", () =>
        owner.thread.update({
          where: { id: threadId },
          data: { nextMessageSeq: input.messageCount },
        }),
      );
    }
    if (input.externalRows.length > 0) {
      await runAsSystem("test fixture", () =>
        owner.externalMessage.createMany({
          data: input.externalRows.map((row, index) => ({
            externalConversationId: created.id,
            providerEventId: `${input.key}-${index}`,
            senderId: row.senderId,
            senderName: row.senderName,
            senderIsBot: row.senderIsBot,
            content: "note",
            createdAt: nextExternalAt(),
          })),
        }),
      );
    }
    return {
      spaceId: input.spaceId,
      botId: input.botId,
      provider: "slack",
      displayName: input.displayName,
      participantNames: input.participantNames,
      teamChatAmbientEnabled: input.teamChatAmbientEnabled,
      teamChatRules: input.teamChatRules,
      automatedSenderPolicies: input.automatedSenderPolicies,
      automatedSenders: input.automatedSenders,
      preview: input.messageCount === 0 ? "" : `${input.previewLabel} ${input.messageCount - 1}`,
      unread: input.unread,
      updatedAt: input.updatedAt.toISOString(),
    };
  }

  function measured<T>(label: string, run: () => Promise<T>) {
    const messageStart = messageReads.length;
    const externalStart = externalReads.length;
    return run().then((result) => {
      const messages = messageReads.slice(messageStart);
      const external = externalReads.slice(externalStart);
      const messageRowCount = messages.reduce((sum, read) => sum + read.rowCount, 0);
      const externalRowCount = external.reduce((sum, read) => sum + read.rowCount, 0);
      const lines = [
        ...messages.map(
          (read) =>
            `-- messages rows ${read.rowCount} values ${JSON.stringify(read.values)}\n${read.text}`,
        ),
        ...external.map(
          (read) =>
            `-- external_messages rows ${read.rowCount} values ${JSON.stringify(read.values)}\n${read.text}`,
        ),
      ];
      process.stdout.write(
        `${label}: messages ${messages.length} statement(s), ${messageRowCount} rows; external_messages ${external.length} statement(s), ${externalRowCount} rows\n${lines.join("\n\n")}\n`,
      );
      return {
        result,
        messageRowCount,
        messageStatements: messages.length,
        externalRowCount,
        external,
      };
    });
  }

  function conversationId(row: unknown, fields: string[]): string | undefined {
    const index = fields.findIndex(
      (name) => name === "externalConversationId" || name.endsWith(".externalConversationId"),
    );
    if (index < 0) return undefined;
    const value = Array.isArray(row) ? row[index] : row && Reflect.get(row, fields[index] ?? "");
    return typeof value === "string" ? value : undefined;
  }

  it("previews the newest team-chat message and caps bot senders at 100 per conversation", async () => {
    const { result, messageRowCount, externalRowCount, external } = await measured(
      "listForSpaces",
      () =>
        runAsSystem("space navigation across the member's Spaces", () =>
          createExternalConversationRepos(prisma).listForSpaces([spaceA, spaceB], userId),
        ),
    );
    const perConversation = new Map<string, number>();
    let attributed = 0;
    for (const read of external) {
      for (const row of read.rows) {
        const id = conversationId(row, read.fields);
        if (!id) continue;
        attributed += 1;
        perConversation.set(id, (perConversation.get(id) ?? 0) + 1);
      }
    }
    process.stdout.write(
      `listForSpaces external rows per conversation: ${JSON.stringify([...perConversation])}\n`,
    );
    expect.soft(messageRowCount).toBeLessThanOrEqual(THREAD_COUNT);
    expect.soft(externalRowCount).toBeLessThanOrEqual(EXTERNAL_ROW_BOUND);
    expect.soft(attributed).toBe(externalRowCount);
    for (const count of perConversation.values()) {
      expect.soft(count).toBeLessThanOrEqual(BOT_SENDER_WINDOW);
    }
    expect(
      result.map((conversation) => ({
        spaceId: conversation.spaceId,
        botId: conversation.botId,
        provider: conversation.provider,
        displayName: conversation.displayName,
        participantNames: conversation.participantNames,
        teamChatAmbientEnabled: conversation.teamChatAmbientEnabled,
        teamChatRules: conversation.teamChatRules,
        automatedSenderPolicies: conversation.automatedSenderPolicies,
        automatedSenders: conversation.automatedSenders,
        preview: conversation.preview,
        unread: conversation.unread,
        updatedAt: conversation.updatedAt,
      })),
    ).toEqual(expected);
  });

  it("reads no messages when the member passes no spaces", async () => {
    const { result, messageRowCount, messageStatements, externalRowCount, external } =
      await measured("listForSpaces empty", () =>
        runAsSystem("space navigation across the member's Spaces", () =>
          createExternalConversationRepos(prisma).listForSpaces([], userId),
        ),
      );
    expect(result).toEqual([]);
    expect(messageStatements).toBe(0);
    expect(messageRowCount).toBe(0);
    expect(externalRowCount).toBe(0);
    expect(external).toEqual([]);
  });
});
