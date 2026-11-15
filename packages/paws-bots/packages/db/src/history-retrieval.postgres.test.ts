import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { HistorySearchInputSchema } from "@rakazo/contracts";
import { escapeJsonSearchWildcards } from "@rakazo/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { PrismaClient } from "./client.js";
import { readHistory, searchHistory } from "./history-retrieval.js";

// Temporary synthetic tables shadow product tables. Never inspect existing chat content.
const enabled = process.env.VERIFY_DATABASE && process.env.DATABASE_URL;
const postgres = enabled ? describe : describe.skip;
postgres("history retrieval (PostgreSQL)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const scope = {
    spaceId: "synthetic-space",
    userId: "synthetic-user",
    threadId: "synthetic-thread",
    botId: "synthetic-bot",
  };
  beforeAll(async () => {
    // The migration's own statement, so the tested predicate cannot drift from production.
    const toolWorkIndex = readFileSync(
      new URL(
        "../prisma/migrations/20261210120000_message_tool_work_idx/migration.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .replace(/^--.*$/gm, "")
      .replace("CONCURRENTLY ", "");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "pg_temp" }) });
    await pool.query(`
      CREATE TEMP TABLE bots (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamptz);
      CREATE TEMP TABLE threads (id text PRIMARY KEY, "spaceId" text, "userId" text, "botId" text, "groupId" text);
      CREATE TEMP TABLE chat_groups (id text PRIMARY KEY, "spaceId" text, "userId" text, "archivedAt" timestamptz);
      CREATE TEMP TABLE chat_group_members ("groupId" text, "botId" text);
      CREATE TEMP TABLE messages (id text PRIMARY KEY, "threadId" text, seq integer, role text, "runId" text,
        "replyToMessageId" text, "createdAt" timestamptz, blocks jsonb);
      CREATE TEMP TABLE steering_messages ("messageId" text, "botId" text, "runId" text,
        UNIQUE ("messageId", "botId"));
      CREATE TEMP TABLE runs (id text PRIMARY KEY, "spaceId" text, "userId" text, "threadId" text, "botId" text,
        "sourceMessageId" text, status text, "createdAt" timestamptz, "completedAt" timestamptz);
      CREATE TEMP TABLE artifacts (id text PRIMARY KEY, "spaceId" text, "userId" text, "botId" text, "groupId" text,
        "runId" text, name text, "mimeType" text, size integer, "createdAt" timestamptz);
      INSERT INTO bots VALUES ('synthetic-bot','synthetic-space','synthetic-user',NULL);
      INSERT INTO threads VALUES ('synthetic-thread','synthetic-space','synthetic-user','synthetic-bot');
      INSERT INTO messages SELECT 'm-' || n, 'synthetic-thread', n, 'user', NULL, NULL,
        '2026-01-01'::timestamptz + n * interval '1 minute',
        jsonb_build_array(jsonb_build_object('kind','text','text', CASE WHEN n = 100 THEN 'exports use batching' ELSE 'filler exchange ' || n END))
        FROM generate_series(1,10000) n;
      CREATE INDEX synthetic_history_fts ON messages USING GIN (to_tsvector('simple',jsonb_path_query_array(blocks,
        '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").result')::text || translate(jsonb_path_query_array(blocks, '$[*] ? (@.kind == "file" || @.kind == "image").name')::text, '._-', '   ') || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*].label')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "steps").steps[*].note')::text));
      CREATE INDEX synthetic_history_seq ON messages ("threadId",seq);
      ${toolWorkIndex}
      ANALYZE messages;
      ALTER TABLE bots ADD COLUMN name text DEFAULT 'History bot';
      ALTER TABLE chat_groups ADD COLUMN name text DEFAULT 'History group';
    `);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });
  it("hides waiting messages per bot in searches, anchors and neighbors until assigned", async () => {
    await pool.query(`
      INSERT INTO bots (id, "spaceId", "userId") VALUES ('waiting-peer','synthetic-space','synthetic-user');
      INSERT INTO chat_groups (id, "spaceId", "userId") VALUES ('waiting-group','synthetic-space','synthetic-user');
      INSERT INTO chat_group_members VALUES ('waiting-group','synthetic-bot'), ('waiting-group','waiting-peer');
      INSERT INTO threads VALUES
        ('waiting-direct','synthetic-space','synthetic-user','waiting-peer',NULL),
        ('waiting-group-thread','synthetic-space','synthetic-user',NULL,'waiting-group');
      INSERT INTO messages SELECT 'waiting-' || n, 'waiting-group-thread', n, 'user', NULL, NULL,
        '2026-01-01'::timestamptz, '[{"kind":"text","text":"waitingprobe"}]'::jsonb
        FROM generate_series(1,3) n;
      INSERT INTO messages VALUES ('waiting-direct-message','waiting-direct',1,'user',NULL,NULL,
        '2026-01-01','[{"kind":"text","text":"waitingprobe"}]');
      INSERT INTO steering_messages VALUES
        ('waiting-2','synthetic-bot',NULL),
        ('waiting-3','waiting-peer',NULL),
        ('waiting-direct-message','waiting-peer',NULL);
    `);
    const group = { ...scope, threadId: "waiting-group-thread", allowMyChats: true };
    const ids = (result: Awaited<ReturnType<typeof searchHistory>>) =>
      result.messages.map((message) => message.messageId).sort();
    expect(ids(await searchHistory(prisma, group, { query: "waitingprobe" }))).toEqual([
      "waiting-1",
      "waiting-3",
    ]);
    expect(
      ids(
        await searchHistory(prisma, { ...group, botId: "waiting-peer" }, { query: "waitingprobe" }),
      ),
    ).toEqual(["waiting-1", "waiting-2"]);
    expect(
      (await readHistory(prisma, group, { messageId: "waiting-2", textOffset: 0 })).messages,
    ).toEqual([]);
    expect(
      (
        await readHistory(prisma, group, { messageId: "waiting-1", direction: "newer" })
      ).messages.map((m) => m.messageId),
    ).toEqual(["waiting-3"]);
    const granted = { ...scope, allowMyChats: true };
    expect(
      ids(await searchHistory(prisma, granted, { scope: "my_chats", query: "waitingprobe" })),
    ).toEqual(["waiting-1", "waiting-3"]);
    expect(
      (
        await readHistory(prisma, granted, {
          threadId: "waiting-direct",
          messageId: "waiting-direct-message",
        })
      ).messages,
    ).toEqual([]);
    expect(
      (await readHistory(prisma, granted, { threadId: group.threadId, messageId: "waiting-2" }))
        .messages,
    ).toEqual([]);
    await pool.query(`UPDATE steering_messages SET "runId" = 'assigned-run'
      WHERE "botId" IN ('synthetic-bot','waiting-peer') AND "messageId" IN ('waiting-2','waiting-direct-message')`);
    expect(
      ids(await searchHistory(prisma, granted, { scope: "my_chats", query: "waitingprobe" })),
    ).toEqual(["waiting-1", "waiting-2", "waiting-3", "waiting-direct-message"]);
    expect(
      (await readHistory(prisma, group, { messageId: "waiting-2", textOffset: 0 })).messages.map(
        (m) => m.messageId,
      ),
    ).toEqual(["waiting-2"]);
    await pool.query(`DELETE FROM steering_messages WHERE "messageId" LIKE 'waiting-%'`);
  });
  it.each([
    { text: String.raw`back\slash`, query: String.raw`back\slash`, matches: true },
    { text: 'say "hi"', query: 'say "hi"', matches: true },
    { text: "50%_off", query: "50%_off", matches: true },
    { text: "line\nbreak", query: "line\nbreak", matches: true },
    { text: "café/東京", query: "café/東京", matches: true },
    { text: "500 off", query: "50%", matches: false },
    { text: "plain text", query: "_", matches: false },
  ])(
    "matches literal JSONB message text: $query in $text ($matches)",
    async ({ text, query, matches }) => {
      // Bypass encrypted message writes and blind indexes to exercise PostgreSQL's JSONB rendering.
      const blocks = JSON.stringify([{ kind: "text", text }]);
      const result = await pool.query<{ matches: boolean }>(
        "SELECT $1::jsonb::text ILIKE $2 AS matches",
        [blocks, `%${escapeJsonSearchWildcards(query)}%`],
      );
      expect(result.rows).toEqual([{ matches }]);
    },
  );
  it("finds a distant fact in 10,000 messages using the full text index", async () => {
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const results = await searchHistory(prisma, scope, { query: "exports batching" });
    const authorizedQuery = querySpy.mock.calls[0]![0] as Prisma.Sql;
    querySpy.mockRestore();
    expect(results.messages.map((message) => message.messageId)).toEqual(["m-100"]);
    const explained = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${authorizedQuery.text}`,
      authorizedQuery.values,
    );
    const plan = explained.rows[0]["QUERY PLAN"][0];
    expect(JSON.stringify(plan)).toContain("synthetic_history_fts");
    expect(plan.Plan["Actual Rows"]).toBe(1);
    expect(plan["Planning Time"]).toBeGreaterThanOrEqual(0);
    expect(plan["Execution Time"]).toBeGreaterThanOrEqual(0);
    process.stdout.write(
      `Synthetic authorized 10k history search ${JSON.stringify({
        messages: 10000,
        index: "equivalent local GIN expression",
        returnedRows: plan.Plan["Actual Rows"],
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
      })}\n`,
    );
  });
  it("finds an earlier reply by its tool step note and returns the steps it ran", async () => {
    await pool.query(
      `INSERT INTO messages VALUES ('steps-reply', 'synthetic-thread', 10001, 'bot', NULL, NULL,
      '2026-03-01T00:00:00Z', $1::jsonb)`,
      [
        JSON.stringify([
          {
            kind: "steps",
            steps: [{ label: "Shell", count: 2, note: "Installing Quillfeather into Chromium." }],
          },
          { kind: "text", text: "Done." },
        ]),
      ],
    );
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const results = await searchHistory(prisma, scope, { query: "quillfeather" });
    const searchQuery = querySpy.mock.calls[0]![0] as Prisma.Sql;
    querySpy.mockRestore();
    expect(results.messages.map((message) => message.messageId)).toEqual(["steps-reply"]);
    expect(results.messages[0]!.text).toContain(
      "- Shell ×2: Installing Quillfeather into Chromium.",
    );
    const explained = await pool.query(
      `EXPLAIN (FORMAT JSON) ${searchQuery.text}`,
      searchQuery.values,
    );
    expect(JSON.stringify(explained.rows[0]["QUERY PLAN"])).toContain("synthetic_history_fts");
    await pool.query(`DELETE FROM messages WHERE id = 'steps-reply'`);
  });
  it("keeps a reply made only of tool steps when search is narrowed to bot replies", async () => {
    await pool.query(
      `INSERT INTO messages VALUES ('steps-only-reply', 'synthetic-thread', 10002, 'bot', NULL, NULL,
      '2026-03-01T00:00:00Z', $1::jsonb)`,
      [
        JSON.stringify([
          {
            kind: "steps",
            steps: [{ label: "Shell", count: 1, note: "Pruning Larkspur caches." }],
          },
        ]),
      ],
    );
    const results = await searchHistory(prisma, scope, {
      query: "larkspur",
      kinds: ["bot_replies"],
    });
    expect(results.messages.map((message) => message.messageId)).toEqual(["steps-only-reply"]);
    await pool.query(`DELETE FROM messages WHERE id = 'steps-only-reply'`);
  });
  it("lists only replies that used tools when browsing tool work without a keyword", async () => {
    await pool.query(
      `INSERT INTO messages VALUES ('browsed-steps', 'synthetic-thread', 10003, 'bot', NULL, NULL,
      '2026-03-01T00:00:00Z', $1::jsonb)`,
      [
        JSON.stringify([
          { kind: "steps", steps: [{ label: "Shell", count: 1, note: "Adding a dark theme." }] },
          { kind: "text", text: "Sites show dark now." },
        ]),
      ],
    );
    const results = await searchHistory(prisma, scope, { kinds: ["tool_work"] });
    expect(results.messages.map((message) => message.messageId)).toEqual(["browsed-steps"]);
    expect(results.messages[0]!.text).toContain("- Shell: Adding a dark theme.");
    // An empty search here points at that earlier tool work.
    const empty = await searchHistory(prisma, scope, { query: "quillfeather zebra" });
    expect(empty.messages).toEqual([]);
    expect(empty.note).toContain('kinds ["tool_work"]');
    const emptyToolWork = await searchHistory(prisma, scope, {
      query: "quillfeather zebra",
      kinds: ["tool_work"],
    });
    expect(emptyToolWork.messages).toEqual([]);
    expect(emptyToolWork.note).toContain('kinds ["tool_work"] and no query');
    await pool.query(`DELETE FROM messages WHERE id = 'browsed-steps'`);
    const plain = await searchHistory(prisma, scope, { query: "quillfeather zebra" });
    expect(plain.note).not.toContain("tool_work");
  });
  it("finds tool work in other chats through the tool work index", async () => {
    await pool.query(
      `INSERT INTO threads VALUES ('tool-elsewhere','synthetic-space','synthetic-user','synthetic-bot',NULL)`,
    );
    await pool.query(
      `INSERT INTO messages VALUES ('elsewhere-steps', 'tool-elsewhere', 1, 'bot', NULL, NULL,
      '2026-03-01T00:00:00Z', $1::jsonb)`,
      [
        JSON.stringify([
          { kind: "steps", steps: [{ label: "Shell", count: 1, note: "Adding a dark theme." }] },
        ]),
      ],
    );
    const granted = { ...scope, allowMyChats: true };
    const explain = async (sql: Prisma.Sql) =>
      JSON.stringify(
        (await pool.query(`EXPLAIN (FORMAT JSON) ${sql.text}`, sql.values)).rows[0]["QUERY PLAN"],
      );
    // An empty all-chats search points at tool work that exists only in another chat.
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const empty = await searchHistory(prisma, granted, {
      scope: "my_chats",
      query: "quillfeather zebra",
    });
    const check = querySpy.mock.calls.at(-1)![0] as Prisma.Sql;
    querySpy.mockClear();
    expect(empty.note).toContain('scope "my_chats", kinds ["tool_work"]');
    expect(check.sql).toContain("SELECT 1 FROM messages");
    expect(await explain(check)).toContain("messages_tool_work_idx");
    // Listing it across chats reads the same index instead of every message's blocks.
    const listed = await searchHistory(prisma, granted, {
      scope: "my_chats",
      kinds: ["tool_work"],
    });
    const browse = querySpy.mock.calls[0]![0] as Prisma.Sql;
    querySpy.mockRestore();
    expect(listed.messages.map((message) => message.messageId)).toEqual(["elsewhere-steps"]);
    expect(await explain(browse)).toContain("messages_tool_work_idx");
    // A this-chat search still offers only this chat's tool work.
    const here = await searchHistory(prisma, scope, { query: "quillfeather zebra" });
    expect(here.note).not.toContain("tool_work");
    await pool.query(`DELETE FROM messages WHERE id = 'elsewhere-steps';
      DELETE FROM threads WHERE id = 'tool-elsewhere'`);
  });
  it("keeps query-specific continuation available after a narrower empty query in the 10k corpus", async () => {
    await pool.query(`INSERT INTO messages SELECT 'continuation-' || n, 'synthetic-thread', n, 'user', NULL, NULL,
      '2026-01-01T00:00:00Z'::timestamptz,
      jsonb_build_array(jsonb_build_object('kind','text','text',CASE WHEN n = 13001
        THEN 'continuation original ORBIT-731' ELSE 'continuation broad topic' END))
      FROM generate_series(13001,13008) n`);
    const historicalScope = { ...scope, searchBeforeSeq: 13008 };
    const broad = await searchHistory(prisma, historicalScope, {
      query: " continuation ",
      beforeSeq: 999999,
      limit: 20,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(broad.messages.map((message) => message.seq)).toEqual([
      13007, 13006, 13005, 13004, 13003,
    ]);
    expect(broad.coverage.status).toBe("partial");
    expect(broad.nextSearch).toEqual({
      query: "continuation",
      beforeSeq: 13003,
      limit: 5,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    const narrow = await searchHistory(prisma, historicalScope, {
      query: "continuation identifier",
    });
    expect(narrow).toMatchObject({
      query: "continuation identifier",
      messages: [],
      coverage: {
        scope: "requested_query_and_range",
        status: "exhausted",
      },
      nextSearch: null,
    });
    const older = await searchHistory(prisma, historicalScope, broad.nextSearch!);
    expect(older.messages.map((message) => message.seq)).toEqual([13002, 13001]);
    expect(older.messages[1]!.text).toContain("ORBIT-731");
    expect(older.coverage.status).toBe("exhausted");
    expect(
      (
        await readHistory(prisma, historicalScope, {
          messageId: older.messages[1]!.messageId,
          limit: 1,
        })
      ).messages[0]!.text,
    ).toContain("ORBIT-731");
    expect(
      (
        await searchHistory(
          prisma,
          { ...historicalScope, spaceId: "foreign-space" },
          broad.nextSearch!,
        )
      ).messages,
    ).toEqual([]);
    for (const page of [broad, narrow, older])
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
  });
  it("enforces the server search boundary, preserves old pagination and keeps explicit reads available", async () => {
    const historicalScope = { ...scope, searchBeforeSeq: 10 };
    const page = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      limit: 3,
      beforeSeq: 999999,
    });
    expect(page.messages.map((message) => message.seq)).toEqual([9, 8, 7]);
    expect(page.nextBeforeSeq).toBe(7);
    const older = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      limit: 3,
      beforeSeq: page.nextBeforeSeq!,
    });
    expect(older.messages.map((message) => message.seq)).toEqual([6, 5, 4]);
    const dated = await searchHistory(prisma, historicalScope, {
      query: "filler exchange",
      after: "2026-01-01T00:05:00Z",
      before: "2026-01-01T00:10:00Z",
      limit: 5,
    });
    expect(dated.messages.map((message) => message.seq)).toEqual([9, 8, 7, 6, 5]);
    expect(
      (
        await searchHistory(
          prisma,
          { ...scope, searchBeforeSeq: 0 },
          { query: "filler exchange", beforeSeq: 999999 },
        )
      ).messages,
    ).toEqual([]);
    // The cutoff belongs only to search: live explicit evidence and linked outcomes remain readable.
    expect(
      (await readHistory(prisma, historicalScope, { messageId: "m-10", limit: 1 })).messages[0]!
        .messageId,
    ).toBe("m-10");
  });
  it("uses UTC day boundaries and preserves offset instants with inclusive after and exclusive before", async () => {
    const day = await searchHistory(
      prisma,
      scope,
      HistorySearchInputSchema.parse({
        query: "filler exchange",
        after: "2026-01-01",
        before: "2026-01-02",
        limit: 3,
      }),
    );
    expect(day.messages.map((message) => message.seq)).toEqual([1439, 1438, 1437]);
    expect(day.nextSearch).toMatchObject({
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-01-02T00:00:00.000Z",
    });
    const offset = await searchHistory(
      prisma,
      scope,
      HistorySearchInputSchema.parse({
        query: "filler exchange",
        after: "2026-01-02T02:00:00+02:00",
        before: "2026-01-02T02:03:00+02:00",
        limit: 5,
      }),
    );
    expect(offset.messages.map((message) => message.seq)).toEqual([1442, 1441, 1440]);
    expect(offset.nextSearch).toBeNull();
  });
  it("finds earlier files by name and lists only files that still belong to the space", async () => {
    await pool.query(`
      INSERT INTO messages VALUES
        ('file-captioned','synthetic-thread',12001,'user',NULL,NULL,now(),
          '[{"kind":"text","text":"Signed copy attached"},{"kind":"file","artifactId":"art-lease","name":"lisbon-office-lease.md","mimeType":"text/markdown","size":64}]'),
        ('file-bare','synthetic-thread',12002,'user',NULL,NULL,now(),
          '[{"kind":"file","artifactId":"art-foreign","name":"porto-warehouse.md","mimeType":"text/markdown","size":64}]');
      INSERT INTO artifacts VALUES
        ('art-lease','synthetic-space','synthetic-user','synthetic-bot',NULL,NULL,'lisbon-office-lease.md','text/markdown',64,now()),
        ('art-foreign','foreign-space','outsider','synthetic-bot',NULL,NULL,'porto-warehouse.md','text/markdown',64,now());
    `);
    const lease = {
      artifactId: "art-lease",
      name: "lisbon-office-lease.md",
      mimeType: "text/markdown",
      size: 64,
      path: "attachments/art-lease.md",
    };
    const found = await searchHistory(prisma, scope, { query: "lisbon lease" });
    expect(
      (await searchHistory(prisma, scope, { query: "lisbon-office-lease.md" })).messages,
    ).toHaveLength(1);
    // One word from the caption, one from the file name.
    expect((await searchHistory(prisma, scope, { query: "signed lease" })).messages).toHaveLength(
      1,
    );
    expect(found.messages).toEqual([
      expect.objectContaining({
        messageId: "file-captioned",
        text: "Signed copy attached",
        attachments: [lease],
      }),
    ]);
    // A name match on a file from another space finds the message but never the file.
    const foreign = await searchHistory(prisma, scope, {
      query: "porto",
      kinds: ["user_messages"],
    });
    expect(foreign.messages.map((message) => message.messageId)).toEqual(["file-bare"]);
    expect(foreign.messages[0]).not.toHaveProperty("attachments");
    const read = await readHistory(prisma, scope, { messageId: "file-captioned" });
    expect(read.messages.find((message) => message.messageId === "file-captioned")).toMatchObject({
      attachments: [lease],
    });
    await pool.query("DELETE FROM artifacts WHERE id = 'art-lease'");
    const afterDelete = await readHistory(prisma, scope, { messageId: "file-captioned" });
    expect(afterDelete.messages.every((message) => !("attachments" in message))).toBe(true);
    await pool.query("DELETE FROM messages WHERE id IN ('file-captioned','file-bare')");
    await pool.query("DELETE FROM artifacts WHERE id = 'art-foreign'");
  });
  it("keeps a message with many files within the response budget and pages through them", async () => {
    // 100 files with long names, as a deployment that raises the per-message limit allows.
    await pool.query(`
      INSERT INTO artifacts SELECT 'many-' || n, 'synthetic-space', 'synthetic-user', 'synthetic-bot', NULL, NULL,
        repeat('n', 200) || n || '.md', 'text/markdown', 1, now() FROM generate_series(1,100) n;
      INSERT INTO messages VALUES ('many-files-neighbor','synthetic-thread',12099,'bot',NULL,NULL,now(),
        '[{"kind":"text","text":"Neighbor context keeps every word of this reply."}]');
      INSERT INTO messages VALUES ('many-files','synthetic-thread',12100,'user',NULL,NULL,now(),
        (SELECT jsonb_agg(jsonb_build_object('kind','file','artifactId','many-' || n,
          'name', repeat('n', 200) || n || '.md','mimeType','text/markdown','size',1)) FROM generate_series(1,100) n));
    `);
    // Files give way before nearby text does.
    const around = await readHistory(prisma, scope, { messageId: "many-files", limit: 3 });
    expect(Buffer.byteLength(JSON.stringify(around))).toBeLessThanOrEqual(10_000);
    expect(around.messages.find((m) => m.messageId === "many-files-neighbor")?.text).toBe(
      "Neighbor context keeps every word of this reply.",
    );
    type Page = { attachments?: Array<{ artifactId: string }>; nextAttachmentOffset?: number };
    const seen: string[] = [];
    let attachmentOffset: number | undefined;
    for (let page = 0; page < 100; page += 1) {
      const read = await readHistory(prisma, scope, {
        messageId: "many-files",
        limit: 1,
        ...(attachmentOffset === undefined ? {} : { attachmentOffset }),
      });
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(10_000);
      const [message] = read.messages as Page[];
      // Never more files than the run copies at once, so every listed path is copied.
      expect(message!.attachments?.length ?? 0).toBeLessThanOrEqual(20);
      seen.push(...(message!.attachments ?? []).map((file) => file.artifactId));
      attachmentOffset = message!.nextAttachmentOffset;
      if (attachmentOffset === undefined) break;
    }
    // Every file is reachable by paging, each listed once.
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
    await pool.query("DELETE FROM messages WHERE id IN ('many-files','many-files-neighbor')");
    await pool.query("DELETE FROM artifacts WHERE id LIKE 'many-%'");
  });
  it("does not index credential prompts or tool metadata", async () => {
    await pool.query(`INSERT INTO messages VALUES
      ('secret-metadata','synthetic-thread',11000,'system',NULL,NULL,now(),
        '[{"kind":"secret_prompt","text":"synthetic credential needle"},{"kind":"progress","text":"hidden trace needle"}]')`);
    expect((await searchHistory(prisma, scope, { query: "needle" })).messages).toEqual([]);
  });
  it("indexes persisted subagent conclusions and retrieves them as linked outcomes", async () => {
    await pool.query(`INSERT INTO messages VALUES ('subagent-result','synthetic-thread',11999,'bot',NULL,NULL,now(),
      '[{"kind":"subagent","agentId":"synthetic-agent","name":"Research","task":"Inspect exports","status":"completed","result":"ledger-indexer produced aurora-investigation.txt"}]');`);
    const result = await searchHistory(prisma, scope, { query: "ledger-indexer" });
    expect(result.messages[0]!.text).toContain("ledger-indexer");
    expect(result.messages[0]!.text).toContain("aurora-investigation.txt");
  });
  it("finds an open task-only background investigation through its original-backed snapshot topic", async () => {
    await pool.query(`INSERT INTO runs VALUES ('task-only-run','synthetic-space','synthetic-user','synthetic-thread',
        'synthetic-bot',NULL,'running',now(),NULL);
      INSERT INTO messages VALUES ('task-only-message','synthetic-thread',11998,'bot','task-only-run',NULL,now(),
        '[{"kind":"subagent","agentId":"synthetic-agent","name":"Research","task":"Inspect quartz routing congestion","status":"running","result":""}]');`);
    const search = await searchHistory(prisma, scope, { query: "quartz routing congestion" });
    expect(search.messages.map((message) => message.messageId)).toEqual(["task-only-message"]);
    const read = await readHistory(prisma, scope, {
      messageId: search.messages[0]!.messageId,
      limit: 1,
    });
    expect(read.messages[0]!.text).toBe("Inspect quartz routing congestion");
    expect(read.snapshots[0]).toMatchObject({
      anchorMessageId: "task-only-message",
      topic: "Inspect quartz routing congestion",
      openRunIds: ["task-only-run"],
    });
    expect(read.runs[0]!.status).toBe("running");
    expect(
      (
        await searchHistory(
          prisma,
          { ...scope, channelId: "channel-a" },
          { query: "quartz routing congestion" },
        )
      ).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'task-only-message'");
    expect(
      (await searchHistory(prisma, scope, { query: "quartz routing congestion" })).messages,
    ).toEqual([]);
  });
  it("retrieves source-less background work only through a surviving private output", async () => {
    await pool.query(`INSERT INTO runs VALUES
      ('background-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',NULL,'completed',now(),now());
      INSERT INTO messages VALUES ('background-result','synthetic-thread',12000,'bot','background-run',NULL,now(),
        '[{"kind":"text","text":"Background investigation complete"}]');`);
    const result = await readHistory(prisma, scope, { messageId: "background-result", limit: 1 });
    expect(result.runs.map((run) => run.id)).toEqual(["background-run"]);
    expect(
      (
        await readHistory(
          prisma,
          { ...scope, channelId: "channel-a" },
          { messageId: "background-result" },
        )
      ).runs,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'background-result'");
    expect((await readHistory(prisma, scope, { messageId: "background-result" })).runs).toEqual([]);
  });
  it("reads native group history only for owned member bots and scopes group artifacts", async () => {
    await pool.query(`INSERT INTO bots VALUES ('synthetic-outsider','synthetic-space','synthetic-user',NULL);
      INSERT INTO chat_groups VALUES ('synthetic-group','synthetic-space','synthetic-user',NULL);
      INSERT INTO chat_group_members VALUES ('synthetic-group','synthetic-bot');
      INSERT INTO threads VALUES ('synthetic-group-thread','synthetic-space','synthetic-user',NULL,'synthetic-group');
      INSERT INTO messages VALUES
        ('group-source','synthetic-group-thread',0,'user',NULL,NULL,now(),'[{"kind":"text","text":"group exports"}]'),
        ('group-outcome','synthetic-group-thread',1,'bot','group-run',NULL,now(),'[{"kind":"text","text":"group exports done"}]');
      INSERT INTO runs VALUES ('group-run','synthetic-space','synthetic-user','synthetic-group-thread','synthetic-bot','group-source','completed',now(),now());
      INSERT INTO artifacts VALUES ('group-artifact','synthetic-space','synthetic-user','synthetic-bot','synthetic-group','group-run','group-report.txt','text/plain',10,now());`);
    const groupScope = { ...scope, threadId: "synthetic-group-thread" };
    expect(
      (await searchHistory(prisma, groupScope, { query: "group exports" })).messages,
    ).toHaveLength(2);
    expect(
      (await readHistory(prisma, groupScope, { messageId: "group-source" })).runs[0]!.artifacts[0]!
        .id,
    ).toBe("group-artifact");
    expect(
      (
        await readHistory(
          prisma,
          { ...groupScope, botId: "synthetic-outsider" },
          { messageId: "group-source" },
        )
      ).messages,
    ).toEqual([]);
    expect(
      (
        await readHistory(
          prisma,
          { ...groupScope, spaceId: "outsider-space" },
          { messageId: "group-source" },
        )
      ).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id IN ('group-source','group-outcome')");
    expect((await readHistory(prisma, groupScope, { messageId: "group-source" })).runs).toEqual([]);
  });
  it("keeps complete JSON and pages all 50 linked runs, 100 artifacts and long original text", async () => {
    const original = `Original evidence\n${"長い\n".repeat(4000)}`;
    await pool.query(
      `INSERT INTO messages VALUES ('paging-source','synthetic-thread',15000,'user',NULL,NULL,now(), $1::jsonb)`,
      [JSON.stringify([{ kind: "text", text: original }])],
    );
    await pool.query(`
      INSERT INTO runs SELECT 'paging-run-' || lpad(n::text,2,'0'), 'synthetic-space','synthetic-user',
        'synthetic-thread','synthetic-bot','paging-source','completed',now(),now() FROM generate_series(0,49) n;
      INSERT INTO artifacts SELECT 'paging-artifact-' || lpad(n::text,3,'0'), 'synthetic-space','synthetic-user',
        'synthetic-bot',NULL,'paging-run-00','report-' || n || '.txt','text/plain',10,now() FROM generate_series(0,99) n;
      INSERT INTO messages SELECT 'paging-outcome-' || n,'synthetic-thread',15001+n,'bot','paging-run-00',NULL,now(),
        jsonb_build_array(jsonb_build_object('kind','text','text', repeat('outcome evidence ',200))) FROM generate_series(0,29) n;
    `);
    const assertBounded = (result: unknown) => {
      const serialized = JSON.stringify(result);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(10000);
      expect(JSON.parse(serialized)).toMatchObject({ untrusted: true });
      expect(serialized).not.toContain("storageKey");
    };
    const runIds = new Set<string>();
    let runAfterId: string | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        runAfterId,
      });
      assertBounded(page);
      for (const run of page.runs) runIds.add(run.id);
      runAfterId = page.nextRunId ?? undefined;
    } while (runAfterId);
    expect(runIds.size).toBe(50);
    const artifactIds = new Set<string>();
    let artifactAfterId: string | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        linkedRunId: "paging-run-00",
        artifactAfterId,
      });
      assertBounded(page);
      for (const artifact of page.runs.flatMap((run) => run.artifacts))
        artifactIds.add(artifact.id);
      artifactAfterId = page.nextArtifactId ?? undefined;
    } while (artifactAfterId);
    expect(artifactIds.size).toBe(100);
    const outcomeIds = new Set<string>();
    let outcomeAfterSeq: number | undefined;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        limit: 1,
        linkedRunId: "paging-run-00",
        outcomeAfterSeq,
      });
      assertBounded(page);
      for (const outcome of page.runs.flatMap((run) => run.outcomes))
        outcomeIds.add(outcome.messageId);
      outcomeAfterSeq = page.nextOutcomeSeq ?? undefined;
    } while (outcomeAfterSeq !== undefined);
    expect(outcomeIds.size).toBe(30);
    let collected = "";
    let textOffset: number | undefined = 0;
    do {
      const page = await readHistory(prisma, scope, {
        messageId: "paging-source",
        textOffset,
        linkedRunId: "paging-run-00",
      });
      assertBounded(page);
      collected += page.messages[0]!.text;
      const next = page.messages[0]!.nextTextOffset ?? undefined;
      if (next !== undefined) expect(next).toBeGreaterThan(textOffset!);
      textOffset = next;
    } while (textOffset !== undefined);
    expect(collected).toBe(original);
    expect(
      (await readHistory(prisma, scope, { messageId: "m-1", linkedRunId: "paging-run-00" })).runs,
    ).toEqual([]);
  });
  it("searches original-backed snapshots and pages from a short source to linked outcomes and open work", async () => {
    await pool.query(`INSERT INTO messages VALUES ('navigation-source','synthetic-thread',16000,'user',NULL,NULL,now(),
      '[{"kind":"text","text":"Inspect the navigation canary"}]');
      INSERT INTO runs VALUES ('navigation-open-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
        'navigation-source','running',now(),NULL),
        ('navigation-complete-run','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot',
        'navigation-source','completed',now(),now());
      INSERT INTO messages VALUES ('navigation-result','synthetic-thread',16001,'bot','navigation-complete-run',NULL,now(),
        '[{"kind":"subagent","task":"Inspect navigation","result":"Navigation diagnostic final result: ledger-indexer"}]');`);
    const search = await searchHistory(prisma, scope, { query: "navigation canary", limit: 1 });
    expect(search.messages[0]!.messageId).toBe("navigation-source");
    const source = await readHistory(prisma, scope, {
      messageId: search.messages[0]!.messageId,
      limit: 1,
    });
    expect(source.snapshots[0]).toMatchObject({
      anchorMessageId: "navigation-source",
      fromSeq: 16000,
      toSeq: 16000,
      source: "original",
      topic: "Inspect the navigation canary",
      openRunIds: ["navigation-open-run"],
    });
    expect(source.snapshots[0]!.outcome).toContain("ledger-indexer");
    const newer = await readHistory(prisma, scope, {
      messageId: source.newerMessageId!,
      direction: "newer",
      limit: 1,
    });
    expect(newer.snapshots[0]!.anchorMessageId).toBe("navigation-result");
    expect(newer.messages[0]!.text).toContain("ledger-indexer");
    expect(newer.runs[0]!.id).toBe("navigation-complete-run");
    await pool.query("UPDATE runs SET status = 'completed' WHERE id = 'navigation-open-run'");
    expect(
      (await readHistory(prisma, scope, { messageId: "navigation-source", limit: 1 })).snapshots[0]!
        .openRunIds,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id IN ('navigation-source','navigation-result')");
    expect((await searchHistory(prisma, scope, { query: "navigation canary" })).messages).toEqual(
      [],
    );
  });
  it("checks ownership and excludes private history from channel retrieval", async () => {
    await pool.query(`
      INSERT INTO messages VALUES
        ('channel-source','synthetic-thread',10001,'user',NULL,NULL,now(),'[{"kind":"channel_message","channelId":"channel-a","text":"exports approved"}]'),
        ('channel-result','synthetic-thread',10002,'bot','run-a',NULL,now(),'[{"kind":"text","text":"exports completed"}]'),
        ('private-source','synthetic-thread',10003,'user',NULL,NULL,now(),'[{"kind":"text","text":"exports private"}]'),
        ('private-result','synthetic-thread',10004,'bot','run-private',NULL,now(),'[{"kind":"text","text":"exports confidential"}]');
      INSERT INTO runs VALUES
        ('run-a','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot','channel-source','completed',now(),now()),
        ('run-private','synthetic-space','synthetic-user','synthetic-thread','synthetic-bot','private-source','completed',now(),now());
    `);
    const channelScope = { ...scope, channelId: "channel-a" };
    expect(
      (await searchHistory(prisma, channelScope, { query: "exports" })).messages.map(
        (message) => message.messageId,
      ),
    ).toEqual(["channel-result", "channel-source"]);
    const read = await readHistory(prisma, channelScope, { messageId: "channel-source" });
    expect(read.messages.map((message) => message.messageId)).toEqual([
      "channel-source",
      "channel-result",
    ]);
    expect(read.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(read.runs[0]!.outcomes[0]!.text).toBe("exports completed");
    expect(
      (await searchHistory(prisma, { ...scope, spaceId: "outsider-space" }, { query: "exports" }))
        .messages,
    ).toEqual([]);
    expect(
      (await readHistory(prisma, channelScope, { messageId: "private-source" })).messages,
    ).toEqual([]);
    await pool.query("DELETE FROM messages WHERE id = 'channel-source'");
    expect((await searchHistory(prisma, channelScope, { query: "exports" })).messages).toEqual([]);
    expect(
      (await readHistory(prisma, channelScope, { messageId: "channel-result" })).messages,
    ).toEqual([]);
  });
  it("authorizes every active chat in the space, including groups, and nothing outside it", async () => {
    await pool.query(`
      INSERT INTO bots (id, "spaceId", "userId", "archivedAt", name) VALUES
        ('cross-peer','synthetic-space','synthetic-user',NULL,'Researcher'),
        ('cross-team','synthetic-space','team-member',NULL,'Team member'),
        ('cross-space','other-space','synthetic-user',NULL,'Other space'),
        ('cross-archived','synthetic-space','synthetic-user',now(),'Archived');
      INSERT INTO chat_groups (id, "spaceId", "userId", "archivedAt") VALUES
        ('cross-group','synthetic-space','synthetic-user',NULL),
        ('cross-archived-group','synthetic-space','synthetic-user',now()),
        ('cross-team-group','synthetic-space','team-member',NULL);
      INSERT INTO threads VALUES
        ('cross-peer-thread','synthetic-space','synthetic-user','cross-peer',NULL),
        ('cross-team-thread','synthetic-space','team-member','cross-team',NULL),
        ('cross-space-thread','other-space','synthetic-user','cross-space',NULL),
        ('cross-archived-thread','synthetic-space','synthetic-user','cross-archived',NULL),
        ('cross-group-thread','synthetic-space','synthetic-user',NULL,'cross-group'),
        ('cross-archived-group-thread','synthetic-space','synthetic-user',NULL,'cross-archived-group'),
        ('cross-team-group-thread','synthetic-space','team-member',NULL,'cross-team-group');
      INSERT INTO chat_group_members VALUES ('cross-group','cross-peer');
      INSERT INTO messages SELECT 'cross-' || id, id, 90000, 'user', NULL, NULL, '2026-02-01'::timestamptz,
        '[{"kind":"text","text":"quasar launch violet apricot"}]'::jsonb
        FROM threads WHERE id LIKE 'cross-%';
      INSERT INTO messages VALUES
        ('cross-structured','cross-peer-thread',90001,'bot',NULL,NULL,'2026-02-02',
          '[{"kind":"bot_message_received","text":"quasar handoff violet"}]'),
        ('cross-reply','cross-peer-thread',90002,'bot',NULL,NULL,'2026-02-03',
          '[{"kind":"text","text":"quasar answer violet"}]');
    `);
    await pool.query(`
      INSERT INTO runs VALUES ('cross-peer-run','synthetic-space','synthetic-user','cross-peer-thread','cross-peer',
        'cross-cross-peer-thread','completed',now(),now());
      UPDATE messages SET "runId" = 'cross-peer-run' WHERE id = 'cross-reply';
      INSERT INTO artifacts VALUES ('cross-artifact','synthetic-space','synthetic-user','cross-peer',NULL,
        'cross-peer-run','launch.txt','text/plain',10,now());
    `);
    const grant = {
      ...scope,
      allowMyChats: true,
      searchBeforeSeq: 1,
      searchAt: new Date("2026-03-01"),
    };
    const input = HistorySearchInputSchema.parse({
      scope: "my_chats",
      queries: [" quasar ", "VIOLET", "QUASAR"],
    });
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const result = await searchHistory(prisma, grant, input);
    const rankedQuery = querySpy.mock.calls[0]![0] as Prisma.Sql;
    querySpy.mockRestore();
    const explained = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${rankedQuery.text}`,
      rankedQuery.values,
    );
    expect(JSON.stringify(explained.rows)).toContain("synthetic_history_fts");
    expect(result.queries).toEqual(["quasar", "VIOLET"]);
    const single = await searchHistory(prisma, grant, { scope: "my_chats", query: "quasar" });
    expect(single.queries).toEqual(["quasar"]);
    for (const hit of single.messages) expect(hit.matchedQueryIndexes).toEqual([0]);
    // A page holds at most five hits; the sixth is on the next one.
    expect(result.messages).toHaveLength(5);
    const rest = await searchHistory(prisma, grant, result.nextSearch!);
    expect(rest.nextSearch).toBeNull();
    const all = [...result.messages, ...rest.messages];
    expect(new Set(all.map((hit) => hit.messageId)).size).toBe(6);
    expect(new Set(all.map((hit) => hit.threadId))).toEqual(
      new Set([
        "cross-peer-thread",
        "cross-group-thread",
        "cross-team-thread",
        "cross-team-group-thread",
      ]),
    );
    for (const hit of all) expect(hit.matchedQueryIndexes).toEqual([0, 1]);
    expect(result.chats?.find((chat) => chat.threadId === "cross-peer-thread")?.name).toBe(
      "Researcher",
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    // A bot filter narrows group membership too; it never grants a thread outside the space.
    expect(
      (await searchHistory(prisma, grant, { ...input, botId: "cross-space" })).messages,
    ).toEqual([]);
    expect(
      (await searchHistory(prisma, grant, { ...input, botId: "cross-peer" })).messages,
    ).toHaveLength(4);
    expect(
      (
        await searchHistory(prisma, grant, { ...input, after: "2026-02-02", before: "2026-02-03" })
      ).messages.map((hit) => hit.messageId),
    ).toEqual(["cross-structured"]);
    for (const [kind, ids] of [
      ["bot_messages", ["cross-structured"]],
      ["bot_replies", ["cross-reply"]],
      [
        "user_messages",
        [
          "cross-cross-peer-thread",
          "cross-cross-group-thread",
          "cross-cross-team-thread",
          "cross-cross-team-group-thread",
        ],
      ],
    ] as const) {
      expect(
        new Set(
          (await searchHistory(prisma, grant, { ...input, kinds: [kind] })).messages.map(
            (hit) => hit.messageId,
          ),
        ),
      ).toEqual(new Set(ids));
    }
    const first = await searchHistory(prisma, grant, { ...input, limit: 2 });
    const next = await searchHistory(prisma, grant, first.nextSearch!);
    const last = await searchHistory(prisma, grant, next.nextSearch!);
    expect(
      new Set([...first.messages, ...next.messages, ...last.messages].map((hit) => hit.messageId))
        .size,
    ).toBe(6);
    expect(last.nextSearch).toBeNull();
    expect((await searchHistory(prisma, grant, { query: "quasar" })).messages).toEqual([]);
    const own = await readHistory(prisma, grant, {
      threadId: "cross-peer-thread",
      messageId: "cross-structured",
      limit: 1,
    });
    expect(own.messages[0]?.text).toContain("quasar handoff");
    expect(
      (
        await readHistory(prisma, grant, {
          threadId: "cross-group-thread",
          messageId: "cross-cross-group-thread",
          limit: 1,
        })
      ).messages,
    ).toHaveLength(1);
    const linked = await readHistory(prisma, grant, {
      threadId: "cross-peer-thread",
      messageId: "cross-cross-peer-thread",
      limit: 1,
    });
    expect(linked.runs[0]?.id).toBe("cross-peer-run");
    expect(linked.runs[0]?.outcomes[0]?.messageId).toBe("cross-reply");
    expect(linked.runs[0]?.artifacts[0]?.id).toBe("cross-artifact");
    const missing = await readHistory(prisma, grant, { threadId: "missing", messageId: "missing" });
    for (const threadId of [
      "cross-space-thread",
      "cross-archived-thread",
      "cross-archived-group-thread",
    ]) {
      expect(
        await readHistory(prisma, grant, { threadId, messageId: `cross-${threadId}` }),
      ).toEqual(missing);
    }
    for (const denied of [
      { ...grant, channelId: "channel-a" },
      { ...grant, allowMyChats: false },
      scope,
    ]) {
      await expect(searchHistory(prisma, denied, input)).rejects.toThrow("direct human app runs");
      expect(
        await readHistory(prisma, denied, {
          threadId: "cross-peer-thread",
          messageId: "cross-structured",
        }),
      ).toEqual(missing);
    }
    await pool.query(`UPDATE bots SET "archivedAt" = now() WHERE id = 'cross-peer'`);
    expect(
      await readHistory(prisma, grant, {
        threadId: "cross-peer-thread",
        messageId: "cross-structured",
      }),
    ).toEqual(missing);
  });
});
