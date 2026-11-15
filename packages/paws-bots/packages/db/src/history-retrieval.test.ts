import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  historyMessageText,
  historyReadText,
  readHistory,
  searchHistory,
} from "./history-retrieval.js";
import { historySearchText } from "./history-text.js";

const scope = { spaceId: "space", threadId: "thread", botId: "bot" };
const row = (seq: number, text = "Use batch exports") => ({
  id: `message-${seq}`,
  seq,
  role: "user",
  blocks: [{ kind: "text", text }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  runId: null,
  replyToMessageId: null,
});
function db() {
  const mock = {
    $queryRaw: vi.fn(),
    run: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { mock, prisma: mock as unknown as PrismaClient };
}
function sql(mock: ReturnType<typeof db>["mock"], call = 0) {
  return mock.$queryRaw.mock.calls[call]![0] as Prisma.Sql;
}
describe("local history retrieval", () => {
  it.each([false, true])(
    "excludes per-bot waiting rows across search and read queries (cross-chat: %s)",
    async (crossChat) => {
      const { mock, prisma } = db();
      const granted = { ...scope, allowMyChats: true };
      mock.$queryRaw.mockResolvedValue([]);
      await searchHistory(prisma, granted, {
        query: "exports",
        ...(crossChat ? { scope: "my_chats" as const } : {}),
      });
      mock.$queryRaw
        .mockResolvedValueOnce([{ ...row(4), threadId: "peer-thread", botId: "peer-bot" }])
        .mockResolvedValueOnce([{ ...row(4), role: "bot", runId: "run" }])
        .mockResolvedValueOnce([]);
      mock.run.findMany.mockResolvedValue([{ id: "run" }]);
      await readHistory(prisma, granted, {
        messageId: "message-4",
        ...(crossChat ? { threadId: "peer-thread" } : {}),
      });
      // The empty search also checks for earlier tool work (call 1) in the scope it searched.
      expect(mock.$queryRaw).toHaveBeenCalledTimes(5);
      for (let call = 0; call < 5; call++) {
        const query = sql(mock, call);
        expect(query.sql).toContain("NOT EXISTS (");
        expect(query.sql).toContain("FROM steering_messages pending");
        expect(query.sql).toContain('pending."messageId" = m.id AND pending."botId" =');
        expect(query.sql).toContain('pending."runId" IS NULL');
        expect(query.values).toContain(scope.botId);
        expect(query.sql.includes('COALESCE(t."botId",')).toBe(crossChat);
      }
    },
  );
  it("bounds search excerpts and pages by stable sequence", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([row(10), row(9), row(8)]);
    const result = await searchHistory(prisma, scope, {
      query: "exports",
      limit: 2,
      beforeSeq: 20,
    });
    expect(result.messages.map((message) => message.seq)).toEqual([10, 9]);
    expect(result.nextBeforeSeq).toBe(9);
    expect(result.untrusted).toBe(true);
    expect(sql(mock).sql).toContain("plainto_tsquery");
    expect(sql(mock).values).toEqual(
      expect.arrayContaining(["space", "bot", "thread", "exports", 20, 3]),
    );
  });
  it("keeps an unfinished broad query actionable after an exhausted narrower query", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw
      .mockResolvedValueOnce([row(7), row(6), row(5), row(4), row(3), row(2)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // no earlier tool work
      .mockResolvedValueOnce([row(2), row(1, "Aurora original label ORBIT-731")]);
    const historicalScope = { ...scope, searchBeforeSeq: 50 };
    const broad = await searchHistory(prisma, historicalScope, {
      query: " Aurora ",
      limit: 20,
      beforeSeq: 9999,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(broad.coverage).toEqual({ scope: "requested_query_and_range", status: "partial" });
    expect(broad.query).toBe("Aurora");
    expect(broad.nextSearch).toEqual({
      query: "Aurora",
      limit: 5,
      beforeSeq: 3,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(sql(mock).values).toContain(50);
    const narrow = await searchHistory(prisma, historicalScope, { query: "extraction" });
    expect(narrow).toMatchObject({
      query: "extraction",
      coverage: {
        scope: "requested_query_and_range",
        status: "exhausted",
      },
      nextBeforeSeq: null,
      nextSearch: null,
    });
    const older = await searchHistory(prisma, historicalScope, broad.nextSearch!);
    expect(older.messages.some((message) => message.text.includes("ORBIT-731"))).toBe(true);
    expect(older.coverage.status).toBe("exhausted");
    expect(sql(mock, 3).values).toContain(3);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(4);
  });
  it("bounds Unicode search pages without discarding the continuation or original offsets", async () => {
    const { mock, prisma } = db();
    const query = "星".repeat(250);
    mock.$queryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => row(10 - index, query + "界".repeat(1000))),
    );
    const result = await searchHistory(prisma, scope, { query });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.nextSearch).toEqual({ query, beforeSeq: 6, limit: 5 });
    expect(result.messages).toHaveLength(5);
    for (const message of result.messages) {
      expect(message.text).toBe(
        (query + "界".repeat(1000)).slice(
          message.textOffset,
          message.textOffset + message.text.length,
        ),
      );
      expect(message.nextTextOffset).toBe(message.textOffset + message.text.length);
    }
  });
  it("keeps non-ASCII multi-query attribution and continuation inside the byte budget", async () => {
    const { mock, prisma } = db();
    const queries = ["星".repeat(499), `${"界".repeat(498)}xx`];
    mock.$queryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        ...row(i, queries.join(" ") + "界".repeat(1000)),
        threadId: "thread",
        chatName: "History",
        matchedQueryIndexes: [0, 1],
      })),
    );
    const result = await searchHistory(prisma, scope, { queries });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.nextSearch).toMatchObject({ queries, offset: 5 });
    expect(result.messages).toHaveLength(5);
    mock.$queryRaw.mockClear();
    await expect(
      searchHistory(prisma, scope, { queries: [`${queries[0]!}x`, queries[1]!] }),
    ).rejects.toThrow("3000 UTF-8 bytes");
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
  it("points search excerpts at the matching portion of an oversized message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"filler ".repeat(1000)}ledger-indexer final outcome`),
    ]);
    const result = await searchHistory(prisma, scope, { query: "ledger-indexer" });
    expect(result.messages[0]!.text).toContain("ledger-indexer");
    expect(result.messages[0]!.textOffset).toBeGreaterThan(6000);
    const original = `${"filler ".repeat(1000)}ledger-indexer final outcome`;
    expect(result.messages[0]!.text).toBe(
      original.slice(
        result.messages[0]!.textOffset,
        result.messages[0]!.textOffset + result.messages[0]!.text.length,
      ),
    );
  });
  it("restricts channel inputs and bot output using the run source, including neighbors", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(4)]).mockResolvedValueOnce([row(3), row(4)]);
    await readHistory(prisma, { ...scope, channelId: "group-channel" }, { messageId: "message-4" });
    for (const call of [0, 1]) {
      expect(sql(mock, call).sql).toContain('source.id = r."sourceMessageId"');
      expect(sql(mock, call).sql).toContain('source."threadId" = t.id');
      expect(sql(mock, call).values).toContain(
        JSON.stringify([{ kind: "channel_message", channelId: "group-channel" }]),
      );
    }
    expect(mock.run.findMany.mock.calls[0]![0].where).toMatchObject({
      ...scope,
      sourceMessage: { threadId: "thread", role: "user" },
    });
  });
  it("does not retrieve runs or artifacts for a missing, cleared, or inaccessible anchor", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([]);
    expect((await readHistory(prisma, scope, { messageId: "foreign" })).messages).toEqual([]);
    expect(mock.run.findMany).not.toHaveBeenCalled();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
    expect(sql(mock).sql).toContain('t."spaceId" =');
    expect(sql(mock).sql).not.toContain('"userId" =');
    expect(sql(mock).sql).toContain('t."botId" =');
  });
  it("reuses originals without inference and invalidates snapshots when content changes", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([row(1)]);
    const first = await readHistory(prisma, scope, { messageId: "message-1" });
    mock.$queryRaw
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([row(1, "Use streaming exports")]);
    const second = await readHistory(prisma, scope, { messageId: "message-1" });
    expect(first.snapshots[0]!.source).toBe("original");
    expect(first.snapshots[0]!.version).not.toBe(second.snapshots[0]!.version);
    expect(second.snapshots[0]!.topic).toBe("Use streaming exports");
  });
  it("pages inside an oversized original without dumping the entire message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"a".repeat(2000)}distant exact fact${"b".repeat(2000)}`),
    ]);
    const result = await readHistory(prisma, scope, { messageId: "message-1", textOffset: 2000 });
    expect(result.messages[0]!.text).toContain("distant exact fact");
    expect(result.messages[0]!.text.length).toBe(2000);
    expect(result.messages[0]!.nextTextOffset).toBe(4000);
    expect(result.messages[0]!.textOffset).toBe(2000);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it("reconstructs UTF-16 pages without splitting surrogate pairs", async () => {
    const { mock, prisma } = db();
    const text = `${"a".repeat(1999)}😀${"b".repeat(2001)}`;
    mock.$queryRaw.mockResolvedValue([row(1, text)]);
    let offset: number | null = 0;
    let reconstructed = "";
    for (let page = 0; offset !== null && page < 10; page++) {
      const result = await readHistory(prisma, scope, {
        messageId: "message-1",
        textOffset: offset,
      });
      const message = result.messages[0]!;
      expect(message.textOffset).toBe(offset);
      expect(Buffer.from(message.text).toString()).toBe(message.text);
      reconstructed += message.text;
      if (message.nextTextOffset !== null) {
        expect(message.nextTextOffset).toBe(offset + message.text.length);
        expect(message.nextTextOffset).toBeGreaterThan(offset);
      }
      offset = message.nextTextOffset;
    }
    expect(offset).toBeNull();
    expect(reconstructed).toBe(text);

    const middle = await readHistory(prisma, scope, { messageId: "message-1", textOffset: 2000 });
    expect(middle.messages[0]!.textOffset).toBe(1999);
    expect(middle.messages[0]!.text.startsWith("😀")).toBe(true);
  });
  it("keeps search excerpt starts and snapshot topics on Unicode boundaries", async () => {
    const { mock, prisma } = db();
    const text = `${"z".repeat(10)}😀${"a".repeat(39)}needle`;
    mock.$queryRaw.mockResolvedValue([row(1, text)]);
    const found = await searchHistory(prisma, scope, { query: "needle" });
    expect(found.messages[0]!.textOffset).toBe(10);
    expect(found.messages[0]!.text).toBe(text.slice(10));
    expect(Buffer.from(found.messages[0]!.text).toString()).toBe(found.messages[0]!.text);

    const topic = `${"x".repeat(199)}😀tail`;
    mock.$queryRaw.mockResolvedValue([row(1, topic)]);
    const result = await readHistory(prisma, scope, { messageId: "message-1" });
    expect(result.snapshots[0]!.topic).toBe("x".repeat(199));
    expect(Buffer.from(result.snapshots[0]!.topic).toString()).toBe(result.snapshots[0]!.topic);
  });
  it("preserves surrogate pairs while reducing Unicode pages to the response budget", async () => {
    const { mock, prisma } = db();
    const text = `${"é".repeat(399)}😀${"é".repeat(399)}!`;
    mock.$queryRaw.mockResolvedValue(Array.from({ length: 5 }, (_, i) => row(10 - i, text)));
    const result = await searchHistory(prisma, scope, { query: "é".repeat(500) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.messages.some((message) => message.text.length < 800)).toBe(true);
    for (const message of result.messages) {
      expect(Buffer.from(message.text).toString()).toBe(message.text);
      expect(message.nextTextOffset).toBe(message.textOffset + message.text.length);
    }
  });
  it("shortens another reference when a single surrogate pair cannot be reduced", async () => {
    const { mock, prisma } = db();
    const first = { ...row(2, "😀"), id: "" };
    const second = { ...row(1, "aa"), id: "other" };
    const ref = (r: typeof first, text: string) => ({
      messageId: r.id,
      seq: r.seq,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      runId: r.runId,
      replyToMessageId: r.replyToMessageId,
      text,
      textOffset: 0,
      nextTextOffset: null,
      truncated: false,
    });
    const unbounded = {
      untrusted: true,
      query: "a",
      coverage: { scope: "requested_query_and_range", status: "exhausted" },
      messages: [ref(first, "😀"), ref(second, "aa")],
      nextBeforeSeq: null,
      nextSearch: null,
    };
    first.id = "i".repeat(10001 - Buffer.byteLength(JSON.stringify(unbounded)));
    mock.$queryRaw.mockResolvedValue([first, second]);
    const result = await searchHistory(prisma, scope, { query: "a" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.messages[0]!.text).toBe("😀");
    expect(result.messages[1]!.text).toBe("a");
    expect(result.messages[1]!.nextTextOffset).toBe(1);
  });
  it("keeps the first complete character when halving would produce an empty reference", async () => {
    const { mock, prisma } = db();
    const message = { ...row(1, "😀a"), id: "" };
    const reference = {
      messageId: "",
      seq: message.seq,
      role: message.role,
      createdAt: message.createdAt.toISOString(),
      runId: message.runId,
      replyToMessageId: message.replyToMessageId,
      text: "😀a",
      textOffset: 0,
      nextTextOffset: null,
      truncated: false,
    };
    const unbounded = {
      untrusted: true,
      query: "a",
      coverage: { scope: "requested_query_and_range", status: "exhausted" },
      messages: [reference],
      nextBeforeSeq: null,
      nextSearch: null,
    };
    message.id = "i".repeat(10001 - Buffer.byteLength(JSON.stringify(unbounded)));
    mock.$queryRaw.mockResolvedValue([message]);
    const result = await searchHistory(prisma, scope, { query: "a" });
    expect(result.messages[0]!.text).toBe("😀");
    expect(result.messages[0]!.nextTextOffset).toBe(2);
  });
  it("fails when metadata leaves no room for even one complete character", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([{ ...row(1, "😀"), id: "i".repeat(10000) }]);
    await expect(searchHistory(prisma, scope, { query: "a" })).rejects.toThrow(
      "History metadata exceeds response budget",
    );
  });
  it("omits non-text secrets, progress, and commands from retrieved text", () => {
    expect(
      historyMessageText([
        { kind: "text", text: "visible" },
        { kind: "secret_prompt", text: "hidden" },
        { kind: "progress", text: "trace" },
      ]),
    ).toBe("visible");
  });
  it("returns an earlier reply's tool steps to the bot but keeps them out of message text", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Shell", count: 2, note: "Installing  Quillfeather\ninto Chromium." },
          { label: "Computer screenshot", count: 1 },
        ],
      },
      { kind: "text", text: "Done." },
    ];
    expect(historyReadText(blocks)).toBe(
      "[tool calls this reply made]\n- Shell ×2: Installing Quillfeather into Chromium.\n- Computer screenshot\nDone.",
    );
    expect(historyMessageText(blocks)).toBe("Done.");
    expect(historySearchText(blocks)).toContain("Quillfeather");
    expect(historySearchText(blocks)).toContain("Computer screenshot");
    expect(historySearchText(blocks)).not.toContain("tool calls this reply");
  });
  it("matches a search on a tool step note and returns the step list", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      {
        ...row(3, ""),
        indexed: true,
        blocks: [
          {
            kind: "steps",
            steps: [{ label: "Shell", count: 1, note: "Installing Quillfeather." }],
          },
          { kind: "text", text: "Done." },
        ],
      },
    ]);
    const result = await searchHistory(prisma, scope, { query: "quillfeather" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toContain("reply made]\n- Shell: Installing Quillfeather.");
  });
  it("lists earlier replies that used tools by kind, without a keyword", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      {
        ...row(3, ""),
        indexed: true,
        blocks: [
          { kind: "steps", steps: [{ label: "Shell", count: 1, note: "Adding a dark theme." }] },
          { kind: "text", text: "Done." },
        ],
      },
    ]);
    const result = await searchHistory(prisma, scope, { kinds: ["tool_work"] });
    expect(result.messages[0]!.text).toContain("- Shell: Adding a dark theme.");
    expect(result).not.toHaveProperty("note");
    const sql = (mock.$queryRaw.mock.calls[0]![0] as Prisma.Sql).sql;
    expect(sql).not.toContain("to_tsvector");
    expect(sql).toContain('@.kind == "steps"');
    await expect(searchHistory(prisma, scope, {})).rejects.toThrow();
  });
  it("says an empty search ruled out only the words it searched", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([]);
    const plain = await searchHistory(prisma, scope, { query: "sister" });
    expect(plain.messages).toEqual([]);
    expect(plain.coverage.status).toBe("exhausted");
    expect(plain.note).toBe(
      "No message matched these words, which does not show it never happened.",
    );
    // Only where earlier replies used tools does it point at listing them.
    mock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ "?column?": 1 }]);
    const withTools = await searchHistory(prisma, scope, { query: "extension install" });
    expect(withTools.note).toContain('list them with kinds ["tool_work"] and no query');
    expect(sql(mock, 3).sql).toContain('@.kind == "steps"');
    // A keyword search already limited to tool work still offers listing it without the keyword.
    mock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ "?column?": 1 }]);
    const toolWorkOnly = await searchHistory(prisma, scope, {
      query: "extension",
      kinds: ["tool_work"],
    });
    expect(toolWorkOnly.note).toContain('kinds ["tool_work"] and no query');
    expect(toolWorkOnly.note).not.toContain("my_chats");
    // After an all-chats search, the hint keeps that scope, since kinds alone searches this chat.
    mock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ "?column?": 1 }]);
    const allChats = await searchHistory(
      prisma,
      { ...scope, allowMyChats: true },
      { query: "extension", scope: "my_chats" },
    );
    expect(allChats.note).toContain('scope "my_chats", kinds ["tool_work"] and no query');
    // That check covers every chat the search could reach, not only this one.
    const crossChatCheck = sql(mock, 7);
    expect(crossChatCheck.sql).toContain('COALESCE(t."botId",');
    expect(crossChatCheck.sql).toContain(
      `m.role = 'bot' AND jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "steps")')`,
    );
    expect(crossChatCheck.values).not.toContain(scope.threadId);
    // A continued search that ends empty says only that nothing more matched.
    mock.$queryRaw.mockReset().mockResolvedValue([]);
    const continued = await searchHistory(prisma, scope, { query: "extension", beforeSeq: 40 });
    expect(continued.note).toBe("No further matches for these words.");
    // A search narrowed by date offers no hint that would take the bot outside that range.
    mock.$queryRaw.mockReset().mockResolvedValue([]);
    const dated = await searchHistory(prisma, scope, { query: "extension", after: "2026-01-01" });
    expect(dated.note).toBe(
      "No message matched these words, which does not show it never happened.",
    );
  });
  it("does not say nothing matched when the scan stopped before the end", async () => {
    const { mock, prisma } = db();
    // Indexed candidates that fail the exact word check keep the scan going until its budget ends.
    mock.$queryRaw.mockImplementation(async () =>
      Array.from({ length: 6 }, (_, index) => ({ ...row(500 - index, "other"), indexed: true })),
    );
    const result = await searchHistory(prisma, scope, { query: "quillfeather" });
    expect(result.messages).toEqual([]);
    expect(result.coverage.status).toBe("partial");
    expect(result.nextSearch).not.toBeNull();
    expect(result.note).toContain(
      "No match in the part searched so far; nextSearch continues the search.",
    );
    // An unfinished search still points at listing earlier tool work without the keyword.
    expect(result.note).toContain('kinds ["tool_work"] and no query');
  });
  it("validates dates, query size and pagination before accessing the database", async () => {
    const { mock, prisma } = db();
    await expect(searchHistory(prisma, scope, { query: "x", before: "invalid" })).rejects.toThrow(
      "Invalid history date",
    );
    await expect(searchHistory(prisma, scope, { query: "x", limit: 0 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: "x", beforeSeq: -1 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: " " })).rejects.toThrow();
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
});
