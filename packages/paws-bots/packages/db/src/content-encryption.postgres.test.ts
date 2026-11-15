import { randomBytes } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { ContentDecryptionError } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import type { ContentExportRecord } from "./content-export.js";
import { exportContent } from "./content-export.js";
import { LocalKeyProvider, masterKeysFromEnv } from "./content-keys.js";
import {
  contentEncryptionStatus,
  migrateContent,
  rewrapSpaceKeys,
  rotateSpaceDataKeys,
} from "./content-migration.js";
import { appendEventInTransaction } from "./events.js";
import { readHistory, searchHistory } from "./history-retrieval.js";
import { createThreadMessage, createThreadMessageInTransaction } from "./messages.js";
import { runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const masterA = { id: "test-a", key: randomBytes(32) };
const masterB = { id: "test-b", key: randomBytes(32) };

describePostgres("content encryption (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `enc-user-${suffix}`;
  const organizationId = `enc-org-${suffix}`;
  const spaceId = `enc-space-${suffix}`;
  const botId = `enc-bot-${suffix}`;
  const threadId = `enc-thread-${suffix}`;
  const scope = { spaceId, userId, threadId, botId };
  const clients: Array<ReturnType<typeof createDb>> = [];
  let prisma: PrismaClient;
  let raw: ReturnType<typeof createDb>["pool"];

  function client(keys = [masterA], options: { encryptContent?: boolean } = {}) {
    // The derived key keeps rows from other suites sharing this database readable.
    const provider = new LocalKeyProvider([...keys, ...masterKeysFromEnv()]);
    // On unless a test switches it, whatever NODE_ENV the developer runs with.
    const db = createDb(databaseUrl!, { keyProvider: provider, encryptContent: true, ...options });
    clients.push(db);
    return db;
  }
  it("decrypts confirmed image intent after filtering only the plain image kind", () =>
    runAsSystem("test fixture", async () => {
      const image: MessageBlock = {
        kind: "image",
        artifactId: "encrypted-image",
        name: "reply.png",
        mimeType: "image/png",
        imageHandling: "confirm",
      };
      const message = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [image],
      });
      expect(await rawBlocks(message.id)).not.toContain('"imageHandling"');
      const found = await prisma.message.findMany({
        where: {
          id: message.id,
          threadId,
          role: "user",
          blocks: { array_contains: [{ kind: "image" }] },
        },
        select: { blocks: true },
      });
      expect(found).toEqual([{ blocks: [image] }]);
    }));

  const rawBlocks = async (id: string) =>
    (await raw.query(`SELECT blocks::text AS blocks FROM messages WHERE id = $1`, [id])).rows[0]
      .blocks as string;

  beforeAll(() =>
    runAsSystem("test fixture", async () => {
      ({ prisma, pool: raw } = client());
      await prisma.user.create({
        data: {
          id: userId,
          name: "Encryption",
          email: `${userId}@rakazo.test`,
          emailVerified: false,
        },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Encryption",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    }),
  );

  afterAll(async () => {
    // Rotation and re-wrapping reach every space in the shared database. Hand all keys back to
    // the derived master key, or other suites and the next run cannot unwrap them once this
    // run's random master keys are gone.
    await runAsSystem("test cleanup", async () => {
      const restore = createDb(databaseUrl!, {
        keyProvider: new LocalKeyProvider([...masterKeysFromEnv(), masterB, masterA]),
        encryptContent: true,
      });
      clients.push(restore);
      await rewrapSpaceKeys(restore.prisma, contentEncryptionOf(restore.prisma)!.ring);
    });
    await prisma?.organization.deleteMany({ where: { id: organizationId } });
    await prisma?.user.deleteMany({ where: { id: userId } });
    for (const db of clients) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("round-trips message blocks and keeps structural filters working", () =>
    runAsSystem("test fixture", async () => {
      const blocks: MessageBlock[] = [
        { kind: "text", text: "The launch codeword is MARIGOLD" },
        {
          kind: "channel_message",
          provider: "slack",
          channelId: "channel-1",
          fromAddress: "u1",
          fromLabel: "Grace",
          text: "Ship on Friday",
        },
      ];
      const message = await createThreadMessage(prisma, { threadId, role: "user", blocks });
      expect(message.blocks).toEqual(blocks);
      const stored = await rawBlocks(message.id);
      expect(stored).not.toContain("MARIGOLD");
      expect(stored).not.toContain("Friday");
      expect(stored).toContain("rkz1:");
      const found = await prisma.message.findMany({
        where: {
          threadId,
          blocks: { array_contains: [{ kind: "channel_message", channelId: "channel-1" }] },
        },
        select: { blocks: true },
      });
      expect(found).toEqual([{ blocks }]);
      const nested = await prisma.thread.findUnique({
        where: { id: threadId },
        select: { messages: { select: { blocks: true }, where: { id: message.id } } },
      });
      expect(nested?.messages).toEqual([{ blocks }]);
    }));

  it("rejects ciphertext moved to another row", () =>
    runAsSystem("test fixture", async () => {
      const source = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "secret one" }],
      });
      const target = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "secret two" }],
      });
      await raw.query(
        `UPDATE messages SET blocks = (SELECT blocks FROM messages WHERE id = $1) WHERE id = $2`,
        [source.id, target.id],
      );
      await expect(prisma.message.findUnique({ where: { id: target.id } })).rejects.toBeInstanceOf(
        ContentDecryptionError,
      );
      await prisma.message.delete({ where: { id: target.id }, select: { id: true } });
    }));

  it("rejects a message moved to another thread, including through raw reads", () =>
    runAsSystem("test fixture", async () => {
      const message = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "victim text" }],
      });
      const otherBot = `enc-bot-moved-${suffix}`;
      await prisma.bot.create({
        data: { id: otherBot, spaceId, userId, name: "Moe", color: "ink" },
      });
      const other = await prisma.thread.create({ data: { spaceId, userId, botId: otherBot } });
      await raw.query(`UPDATE messages SET "threadId" = $1, seq = 99999 WHERE id = $2`, [
        other.id,
        message.id,
      ]);
      const fresh = client();
      await expect(
        fresh.prisma.message.findUnique({ where: { id: message.id }, select: { blocks: true } }),
      ).rejects.toBeInstanceOf(ContentDecryptionError);
      const rows = (
        await raw.query(`SELECT id, "threadId", blocks FROM messages WHERE id = $1`, [message.id])
      ).rows;
      await expect(
        contentEncryptionOf(fresh.prisma)!.openRows("Message", rows),
      ).rejects.toBeInstanceOf(ContentDecryptionError);
      await raw.query(`DELETE FROM messages WHERE id = $1`, [message.id]);
    }));

  it("finds an encrypted message by its attachment's name without storing the name in plaintext", () =>
    runAsSystem("test fixture", async () => {
      const message = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [
          {
            kind: "file",
            artifactId: `enc-art-${suffix}`,
            name: "harbor-survey.pdf",
            mimeType: "application/pdf",
            size: 10,
          },
        ],
      });
      expect(await rawBlocks(message.id)).not.toContain("harbor");
      const found = await searchHistory(prisma, scope, { query: "harbor survey" });
      expect(found.messages.map((m) => m.messageId)).toEqual([message.id]);
      await prisma.message.delete({ where: { id: message.id }, select: { id: true } });
    }));

  it("keeps a reply's tool history encrypted, out of ordinary reads and out of search", () =>
    runAsSystem("test fixture", async () => {
      const blocks = [
        {
          kind: "steps",
          steps: [
            {
              label: "Shell",
              tool: "shell",
              count: 1,
              calls: [{ arguments: '{"command":"cat ledger"}', result: "OSPREY-TOTAL 4410" }],
            },
          ],
        },
        { kind: "text", text: "Checked the ledger." },
      ] as MessageBlock[];
      const message = await createThreadMessage(prisma, { threadId, role: "bot", botId, blocks });
      expect(message).not.toHaveProperty("toolHistory");
      const {
        rows: [stored],
      } = await raw.query<{ blocks: string; toolHistory: string }>(
        `SELECT blocks::text AS blocks, "toolHistory" FROM messages WHERE id = $1`,
        [message.id],
      );
      expect(stored!.blocks).not.toContain("OSPREY");
      expect(stored!.toolHistory).not.toContain("OSPREY");
      expect(stored!.toolHistory).toContain("rkz1:");
      // Reads leave it out, nested ones too, unless they ask for it.
      expect(await prisma.message.findUnique({ where: { id: message.id } })).not.toHaveProperty(
        "toolHistory",
      );
      const nested = await prisma.thread.findUnique({
        where: { id: threadId },
        include: { messages: { where: { id: message.id } } },
      });
      expect(nested?.messages[0]).not.toHaveProperty("toolHistory");
      const selected = await prisma.message.findUnique({
        where: { id: message.id },
        select: { toolHistory: true },
      });
      expect(JSON.parse(selected!.toolHistory!).steps[0].calls[0].result).toBe("OSPREY-TOTAL 4410");
      expect((await searchHistory(prisma, scope, { query: "osprey" })).messages).toEqual([]);
      await prisma.message.delete({ where: { id: message.id }, select: { id: true } });
    }));

  it("reads and searches plaintext rows next to encrypted ones, then migrates them", () =>
    runAsSystem("test fixture", async () => {
      const plaintextId = `enc-plain-${suffix}`;
      await raw.query(
        `INSERT INTO messages (id, "threadId", seq, role, blocks) VALUES ($1, $2, 9000, 'user', $3::jsonb)`,
        [
          plaintextId,
          threadId,
          JSON.stringify([{ kind: "text", text: "legacy note about pelicans" }]),
        ],
      );
      await createThreadMessage(prisma, {
        threadId,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "fresh note about pelicans" }],
      });
      const read = await prisma.message.findUnique({ where: { id: plaintextId } });
      expect(read?.blocks).toEqual([{ kind: "text", text: "legacy note about pelicans" }]);

      const texts = async () =>
        (await searchHistory(prisma, scope, { query: "pelicans" })).messages
          .map((m) => m.text)
          .sort();
      expect(await texts()).toEqual(["fresh note about pelicans", "legacy note about pelicans"]);

      const before = await contentEncryptionStatus(prisma);
      expect(before.tables.find((t) => t.table === "messages")!.plaintext).toBeGreaterThan(0);
      await migrateContent(prisma, { mode: "encrypt" });
      expect(await rawBlocks(plaintextId)).not.toContain("pelicans");
      expect(await texts()).toEqual(["fresh note about pelicans", "legacy note about pelicans"]);
      // Status is database-wide, and suites running alongside may write plaintext
      // with encryption off, so check this suite's rows directly.
      const left = await raw.query(
        `SELECT count(*)::int AS n FROM messages m WHERE m."threadId" = $1 AND COALESCE(cardinality(m."searchTokens"), 0) = 0`,
        [threadId],
      );
      expect(left.rows[0].n).toBe(0);
      // Variants across the user's chats verify each query against the decrypted text.
      const variants = await searchHistory(
        prisma,
        { ...scope, allowMyChats: true },
        { scope: "my_chats", queries: ["legacy pelicans", "fresh note"] },
      );
      expect(
        variants.messages.map((m) => [m.text, m.matchedQueryIndexes, m.threadId]).sort(),
      ).toEqual([
        ["fresh note about pelicans", [1], threadId],
        ["legacy note about pelicans", [0], threadId],
      ]);

      const excerpt = await readHistory(prisma, scope, { messageId: plaintextId, limit: 1 });
      expect(excerpt.messages[0]!.text).toBe("legacy note about pelicans");
    }));

  it("migrates tool history written with encryption off, and writes it back for a rollback", () =>
    runAsSystem("test fixture", async () => {
      const id = `enc-tools-plain-${suffix}`;
      const history = JSON.stringify({
        steps: [{ tool: "shell", calls: [{ arguments: "{}", result: "HERON-LEDGER 77" }] }],
      });
      // As a release with encryption off stores it.
      await raw.query(
        `INSERT INTO messages (id, "threadId", seq, role, blocks, "toolHistory") VALUES ($1, $2, 9100, 'bot', '[]'::jsonb, $3)`,
        [id, threadId, history],
      );
      const status = await contentEncryptionStatus(prisma);
      expect(
        status.tables.find((t) => t.table === "messages.toolHistory")!.plaintext,
      ).toBeGreaterThan(0);
      const stored = async () =>
        (
          await raw.query<{ toolHistory: string }>(
            `SELECT "toolHistory" FROM messages WHERE id = $1`,
            [id],
          )
        ).rows[0]!.toolHistory;
      await migrateContent(prisma, { mode: "encrypt" });
      expect(await stored()).not.toContain("HERON");
      expect(await stored()).toMatch(/^rkz1:/);
      const read = await prisma.message.findUnique({
        where: { id },
        select: { toolHistory: true },
      });
      expect(read?.toolHistory).toBe(history);
      await migrateContent(prisma, { mode: "decrypt" });
      expect(await stored()).toBe(history);
      await migrateContent(prisma, { mode: "encrypt" });
      await prisma.message.delete({ where: { id }, select: { id: true } });
    }));

  it("encrypts memory, revisions, event payloads and thread summaries", () =>
    runAsSystem("test fixture", async () => {
      const doc = await prisma.memoryDocument.create({
        data: {
          spaceId,
          userId,
          scope: "user",
          path: `notes-${suffix}.md`,
          content: "Allergic to kiwi",
        },
      });
      await prisma.memoryRevision.create({
        data: { documentId: doc.id, revision: 1, content: "Allergic to kiwi" },
      });
      const updated = await prisma.memoryDocument.update({
        where: { id: doc.id },
        data: { content: "Allergic to kiwi and figs", revision: 2 },
      });
      expect(updated.content).toBe("Allergic to kiwi and figs");
      const stored = await raw.query(
        `SELECT d.content AS doc, r.content AS rev FROM memory_documents d JOIN memory_revisions r ON r."documentId" = d.id WHERE d.id = $1`,
        [doc.id],
      );
      expect(JSON.stringify(stored.rows)).not.toContain("kiwi");
      expect(
        (
          await prisma.memoryDocument.findUnique({
            where: { id: doc.id },
            include: { revisions: true },
          })
        )?.revisions[0]?.content,
      ).toBe("Allergic to kiwi");

      const event = await prisma.$transaction((tx) =>
        appendEventInTransaction(tx, {
          spaceId,
          threadId,
          botId,
          type: "thread.message.created",
          payload: {
            messageId: "m-1",
            notice: "stuck",
            blocks: [{ kind: "text", text: "quokka" }],
          },
        }),
      );
      expect(
        JSON.stringify(
          (await raw.query(`SELECT payload FROM events WHERE id = $1`, [event.id])).rows,
        ),
      ).not.toContain("quokka");
      const byPath = await prisma.event.findMany({
        where: { threadId, payload: { path: ["notice"], equals: "stuck" } },
      });
      expect(byPath.map((row) => row.payload)).toEqual([
        { messageId: "m-1", notice: "stuck", blocks: [{ kind: "text", text: "quokka" }] },
      ]);

      await prisma.thread.update({
        where: { id: threadId },
        data: { historyCompactionSummary: "They discussed the wombat budget" },
      });
      expect(
        (
          await raw.query(`SELECT "historyCompactionSummary" AS s FROM threads WHERE id = $1`, [
            threadId,
          ])
        ).rows[0].s,
      ).toMatch(/^rkz1:/);
      expect(
        (await prisma.thread.findUnique({ where: { id: threadId } }))?.historyCompactionSummary,
      ).toBe("They discussed the wombat budget");
    }));

  it("creates a thread and its first message in one transaction", () =>
    runAsSystem("test fixture", async () => {
      const otherBot = `enc-bot-2-${suffix}`;
      await prisma.bot.create({
        data: { id: otherBot, spaceId, userId, name: "Lin", color: "ink" },
      });
      const message = await prisma.$transaction(async (tx) => {
        const thread = await tx.thread.create({ data: { spaceId, userId, botId: otherBot } });
        return createThreadMessageInTransaction(tx, {
          threadId: thread.id,
          role: "user",
          blocks: [{ kind: "text", text: "first words" }],
        });
      });
      expect(await rawBlocks(message.id)).not.toContain("first words");
    }));

  it("rejects nested writes that would store plaintext", () =>
    runAsSystem("test fixture", async () => {
      await expect(
        prisma.thread.create({
          data: {
            spaceId,
            userId,
            messages: { create: { seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] } },
          },
        }),
      ).rejects.toThrow(/nested write/);
    }));

  it("encrypts bot inbox mail, migrates plaintext mail and writes it back for a rollback", () =>
    runAsSystem("test fixture", async () => {
      const mail = await prisma.botEmailMessage.create({
        data: {
          spaceId,
          botId,
          key: `enc-mail-${suffix}`,
          fromAddress: "grace@harbor.test",
          // A sender's name that looks like ciphertext.
          fromName: "rkz1:missing:Grace",
          verified: true,
          subject: "Ocelot sighting",
          text: "Seen near the ocelot pens",
        },
      });
      expect(mail).toMatchObject({ fromAddress: "grace@harbor.test", subject: "Ocelot sighting" });
      const legacy = `enc-mail-plain-${suffix}`;
      await raw.query(
        `INSERT INTO bot_email_messages (id, "spaceId", "botId", key, "references", "fromAddress", "fromName", verified, "to", cc, subject, text)
         VALUES ($1, $2, $3, $1, '{}', 'old@harbor.test', 'Old', true, '{}', '{}', 'Legacy ocelot', 'Plain ocelot text')`,
        [legacy, spaceId, botId],
      );
      const stored = async () =>
        (
          await raw.query(
            `SELECT "fromAddress", "fromName", subject, text, "searchTokens" AS tokens FROM bot_email_messages WHERE "botId" = $1`,
            [botId],
          )
        ).rows as Array<Record<string, unknown> & { tokens: number[] | null }>;
      expect((await stored()).find((row) => row.subject === "Legacy ocelot")?.tokens).toBeNull();

      await migrateContent(prisma, { mode: "encrypt" });
      const sealed = await stored();
      expect(JSON.stringify(sealed)).not.toMatch(/ocelot|harbor|Grace/i);
      expect(sealed.every((row) => row.tokens?.length)).toBe(true);
      const read = await prisma.botEmailMessage.findMany({
        where: { botId },
        orderBy: { key: "asc" },
        select: { fromAddress: true, subject: true, text: true },
      });
      expect(read).toEqual([
        {
          fromAddress: "grace@harbor.test",
          subject: "Ocelot sighting",
          text: "Seen near the ocelot pens",
        },
        { fromAddress: "old@harbor.test", subject: "Legacy ocelot", text: "Plain ocelot text" },
      ]);

      await migrateContent(prisma, { mode: "decrypt" });
      const plain = await stored();
      expect(plain.map((row) => row.subject).sort()).toEqual(["Legacy ocelot", "Ocelot sighting"]);
      expect(plain.every((row) => row.tokens === null)).toBe(true);
      expect(plain.map((row) => row.fromName)).toContain("\u200brkz1:missing:Grace");
      await expect(prisma.botEmailMessage.findMany({ where: { botId } })).resolves.toHaveLength(2);
      await migrateContent(prisma, { mode: "encrypt" });
    }));

  it("re-wraps space keys under a new master key and re-encrypts content", () =>
    runAsSystem("test fixture", async () => {
      const message = await createThreadMessage(prisma, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "rotation survives axolotls" }],
      });
      const rotating = client([masterB, masterA]);
      const keys = contentEncryptionOf(rotating.prisma)!.ring;
      expect(await rewrapSpaceKeys(rotating.prisma, keys)).toMatchObject({
        rewrapped: expect.any(Number),
      });
      const masters = await raw.query(
        `SELECT DISTINCT "masterKeyId" FROM space_keys WHERE "spaceId" = $1`,
        [spaceId],
      );
      expect(masters.rows).toEqual([{ masterKeyId: "test-b" }]);

      const onlyB = client([masterB]);
      expect(
        (await onlyB.prisma.message.findUnique({ where: { id: message.id } }))?.blocks,
      ).toEqual([{ kind: "text", text: "rotation survives axolotls" }]);
      const onlyA = client([masterA]);
      await expect(onlyA.prisma.message.findUnique({ where: { id: message.id } })).rejects.toThrow(
        /Master key test-b is not configured/,
      );

      const before = (await rawBlocks(message.id)).match(/rkz1:([^:]+):/)![1];
      await rotateSpaceDataKeys(onlyB.prisma, contentEncryptionOf(onlyB.prisma)!.ring);
      await migrateContent(onlyB.prisma, { mode: "reencrypt" });
      const afterKey = (await rawBlocks(message.id)).match(/rkz1:([^:]+):/)![1];
      expect(afterKey).not.toBe(before);
      const versions = await raw.query(
        `SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`,
        [spaceId],
      );
      expect(versions.rows[0].n).toBe(2);
      const search = await searchHistory(onlyB.prisma, scope, { query: "axolotls" });
      expect(search.messages.map((m) => m.messageId)).toEqual([message.id]);
    }));

  it("writes plaintext back for a rollback", () =>
    runAsSystem("test fixture", async () => {
      const db = client([masterB]);
      await migrateContent(db.prisma, { mode: "decrypt" });
      const stored = await raw.query(
        `SELECT count(*)::int AS n FROM messages WHERE "threadId" = $1 AND blocks::text LIKE '%rkz1:%'`,
        [threadId],
      );
      expect(stored.rows[0].n).toBe(0);
      expect(await rawBlocks(`enc-plain-${suffix}`)).toContain("pelicans");
      await migrateContent(db.prisma, { mode: "encrypt" });
    }));

  it("destroys a space's keys when the space is deleted", () =>
    runAsSystem("test fixture", async () => {
      const doomed = `enc-doomed-${suffix}`;
      await prisma.space.create({ data: { id: doomed, organizationId, name: "Doomed" } });
      await prisma.memoryDocument.create({
        data: { spaceId: doomed, userId, scope: "user", path: "MEMORY.md", content: "gone soon" },
      });
      const count = async () =>
        (
          await raw.query(`SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`, [
            doomed,
          ])
        ).rows[0].n;
      expect(await count()).toBe(1);
      await prisma.space.delete({ where: { id: doomed } });
      expect(await count()).toBe(0);
    }));

  it("leaves no vault key behind for a member or Space deleted while it is created", () =>
    runAsSystem("test fixture", async () => {
      const ring = contentEncryptionOf(prisma)!.ring;
      const goneSpace = `enc-gone-space-${suffix}`;
      const goneUser = `enc-gone-user-${suffix}`;
      await prisma.space.create({ data: { id: goneSpace, organizationId, name: "Gone" } });
      await prisma.user.create({
        data: {
          id: goneUser,
          name: "Gone",
          email: `${goneUser}@rakazo.test`,
          emailVerified: false,
        },
      });
      const keys = async (scope: string) =>
        (await raw.query(`SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`, [scope]))
          .rows[0].n;
      const waitingOnLock = async () =>
        (
          await raw.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%INSERT INTO space_keys%'`,
          )
        ).rows[0].n > 0;
      const deletions: Array<[string, (tx: Prisma.TransactionClient) => Promise<unknown>]> = [
        [`vault:${goneSpace}`, (tx) => tx.space.delete({ where: { id: goneSpace } })],
        [`user:${goneUser}`, (tx) => tx.user.delete({ where: { id: goneUser } })],
      ];
      for (const [scope, remove] of deletions) {
        let created: Promise<string> = Promise.resolve("not started");
        // The deletion has run its key-shredding trigger but not committed when the key is
        // created. It commits once the key is in, or once creating it waits on the owner.
        await prisma.$transaction(
          async (tx) => {
            await remove(tx);
            created = ring.current(scope).then(
              () => "created",
              () => "refused",
            );
            for (let tries = 0; tries < 100; tries++) {
              if (await Promise.race([created.then(() => true), waitingOnLock()])) break;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          },
          { timeout: 15_000 },
        );
        expect(await keys(scope)).toBe(0);
        expect(await created).toBe("refused");
      }
    }));

  // Its own space, so key counts and searches see only these rows. Global steps
  // (migrate) run here, where every master key this file uses is configured.
  describe("with CONTENT_ENCRYPTION switched", () => {
    const switchSpaceId = `enc-switch-space-${suffix}`;
    const switchBotId = `enc-switch-bot-${suffix}`;
    const switchThreadId = `enc-switch-thread-${suffix}`;
    const scope = { spaceId: switchSpaceId, userId, threadId: switchThreadId, botId: switchBotId };
    let on: ReturnType<typeof createDb>;
    let off: ReturnType<typeof createDb>;

    beforeAll(() =>
      runAsSystem("test fixture", async () => {
        on = client([masterB, masterA], { encryptContent: true });
        off = client([masterB, masterA], { encryptContent: false });
        await prisma.space.create({ data: { id: switchSpaceId, organizationId, name: "Switch" } });
        await prisma.bot.create({
          data: { id: switchBotId, spaceId: switchSpaceId, userId, name: "Bo", color: "ink" },
        });
        await prisma.thread.create({
          data: { id: switchThreadId, spaceId: switchSpaceId, userId, botId: switchBotId },
        });
      }),
    );

    const system = <T>(work: () => Promise<T>) => runAsSystem("test fixture", work);
    const query = async <T>(text: string, values: unknown[]) =>
      (await raw.query(text, values)).rows as T[];
    const stored = async (id: string) =>
      (
        await query<{ blocks: string; tokens: number[] | null }>(
          `SELECT blocks::text AS blocks, "searchTokens" AS tokens FROM messages WHERE id = $1`,
          [id],
        )
      )[0]!;
    const spaceKeys = async () =>
      (
        await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`,
          [switchSpaceId],
        )
      )[0]!.n;
    const found = async (prisma: PrismaClient, words: string) =>
      (await searchHistory(prisma, scope, { query: words })).messages.map((m) => m.text).sort();
    const say = (prisma: PrismaClient, text: string) =>
      createThreadMessage(prisma, {
        threadId: switchThreadId,
        role: "bot",
        botId: switchBotId,
        blocks: [{ kind: "text", text }],
      });

    it("writes plaintext with encryption off, without creating keys, and searches it", () =>
      system(async () => {
        const message = await say(off.prisma, "narwhal one, written while off");
        expect(await stored(message.id)).toMatchObject({ tokens: null });
        expect((await stored(message.id)).blocks).toContain("narwhal one");
        const doc = await off.prisma.memoryDocument.create({
          data: {
            spaceId: switchSpaceId,
            userId,
            botId: switchBotId,
            scope: "bot",
            path: "notes.md",
            content: "Likes kelp",
          },
        });
        await off.prisma.memoryRevision.create({
          data: { documentId: doc.id, revision: 1, content: "Likes kelp" },
        });
        await off.prisma.thread.update({
          where: { id: switchThreadId },
          data: { historyCompactionSummary: "They talked about kelp" },
        });
        const plain = await query<{ doc: string; rev: string; summary: string }>(
          `SELECT d.content AS doc, r.content AS rev, t."historyCompactionSummary" AS summary
           FROM memory_documents d JOIN memory_revisions r ON r."documentId" = d.id
           JOIN threads t ON t.id = $2 WHERE d.id = $1`,
          [doc.id, switchThreadId],
        );
        expect(plain).toEqual([
          { doc: "Likes kelp", rev: "Likes kelp", summary: "They talked about kelp" },
        ]);
        expect(await spaceKeys()).toBe(0);
        expect(await found(off.prisma, "narwhal")).toEqual(["narwhal one, written while off"]);
      }));

    it("keeps everything readable and searchable from on to off and back on", () =>
      system(async () => {
        const sealed = await say(on.prisma, "narwhal two, sealed while on");
        expect((await stored(sealed.id)).blocks).not.toContain("narwhal");
        expect(await spaceKeys()).toBe(1);

        // Off: the sealed row still reads and matches through its tokens.
        expect((await off.prisma.message.findUnique({ where: { id: sealed.id } }))?.blocks).toEqual(
          [{ kind: "text", text: "narwhal two, sealed while on" }],
        );
        expect(await found(off.prisma, "narwhal")).toEqual([
          "narwhal one, written while off",
          "narwhal two, sealed while on",
        ]);
        // Rewritten while off, it is stored readable and stops matching its old words.
        await off.prisma.message.update({
          where: { id: sealed.id },
          data: { blocks: [{ kind: "text", text: "narwhal two, edited while off" }] },
          select: { id: true },
        });
        expect(await stored(sealed.id)).toMatchObject({ tokens: [] });
        const status = await contentEncryptionStatus(off.prisma);
        expect(status.tables.find((t) => t.table === "messages")!.plaintext).toBeGreaterThanOrEqual(
          2,
        );
        expect((await stored(sealed.id)).blocks).toContain("edited while off");
        expect(await found(off.prisma, "sealed")).toEqual([]);
        expect(await found(off.prisma, "edited")).toEqual(["narwhal two, edited while off"]);

        // Back on: new content is sealed, the mixed rows read, and migrate seals the rest.
        const third = await say(on.prisma, "narwhal three, sealed again");
        expect((await stored(third.id)).blocks).not.toContain("narwhal");
        const all = [
          "narwhal one, written while off",
          "narwhal three, sealed again",
          "narwhal two, edited while off",
        ];
        expect(await found(on.prisma, "narwhal")).toEqual(all);
        await migrateContent(on.prisma, { mode: "encrypt" });
        for (const id of [sealed.id, third.id]) {
          expect((await stored(id)).blocks).not.toContain("narwhal");
          expect((await stored(id)).tokens?.length).toBeGreaterThan(0);
        }
        const plaintext = await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages WHERE "threadId" = $1 AND blocks::text LIKE '%narwhal%'`,
          [switchThreadId],
        );
        expect(plaintext[0]!.n).toBe(0);
        expect(await found(on.prisma, "narwhal")).toEqual(all);
        expect(await found(off.prisma, "narwhal")).toEqual(all);
        expect(
          (await off.prisma.thread.findUnique({ where: { id: switchThreadId } }))
            ?.historyCompactionSummary,
        ).toBe("They talked about kelp");
      }));

    it("exports decrypted content by thread, bot and space", () =>
      system(async () => {
        await say(off.prisma, "narwhal four, plaintext beside ciphertext");
        const collect = async (filter: Parameters<typeof exportContent>[1]) => {
          const records: ContentExportRecord[] = [];
          for await (const record of exportContent(off.prisma, filter)) records.push(record);
          return records;
        };
        const byThread = await collect({ threadId: switchThreadId });
        expect(byThread[0]).toMatchObject({
          type: "thread",
          id: switchThreadId,
          spaceId: switchSpaceId,
          botId: switchBotId,
          historyCompactionSummary: "They talked about kelp",
        });
        expect(byThread.filter((record) => record.type === "message").map((r) => r.text)).toEqual([
          "narwhal one, written while off",
          "narwhal two, edited while off",
          "narwhal three, sealed again",
          "narwhal four, plaintext beside ciphertext",
        ]);
        expect(byThread.some((record) => record.type === "memory_document")).toBe(false);
        expect(JSON.stringify(byThread)).not.toContain("rkz1:");

        const bySpace = await collect({ spaceId: switchSpaceId });
        expect(bySpace.map((record) => record.type)).toEqual([
          "thread",
          "message",
          "message",
          "message",
          "message",
          "memory_document",
          "memory_revision",
        ]);
        expect(bySpace.at(-2)).toMatchObject({
          path: "notes.md",
          content: "Likes kelp",
          botId: switchBotId,
        });
        expect(bySpace.at(-1)).toMatchObject({
          revision: 1,
          content: "Likes kelp",
          spaceId: switchSpaceId,
        });
        expect(JSON.stringify(bySpace)).not.toContain("rkz1:");
        expect(await collect({ botId: switchBotId })).toEqual(bySpace);
        expect(await collect({ botId: `missing-${suffix}` })).toEqual([]);

        // In another bot's thread, a bot export keeps only that bot's messages and
        // leaves out the thread's summary, which covers the whole conversation.
        const otherBot = `enc-switch-other-${suffix}`;
        await prisma.bot.create({
          data: { id: otherBot, spaceId: switchSpaceId, userId, name: "Cy", color: "ink" },
        });
        const otherThread = await off.prisma.thread.create({
          data: {
            spaceId: switchSpaceId,
            userId,
            botId: otherBot,
            historyCompactionSummary: "Private chatter",
          },
        });
        await createThreadMessage(off.prisma, {
          threadId: otherThread.id,
          role: "user",
          blocks: [{ kind: "text", text: "only for Cy" }],
        });
        await createThreadMessage(off.prisma, {
          threadId: otherThread.id,
          role: "bot",
          botId: switchBotId,
          blocks: [{ kind: "text", text: "Bo dropped in" }],
        });
        const visiting = (await collect({ botId: switchBotId })).filter(
          (record) =>
            record.id === otherThread.id ||
            (record.type === "message" && record.threadId === otherThread.id),
        );
        expect(visiting).toMatchObject([
          { type: "thread", historyCompactionSummary: null },
          { type: "message", text: "Bo dropped in" },
        ]);
        expect(visiting).toHaveLength(2);
      }));
  });
});
