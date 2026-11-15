import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  isBackgroundRun,
  isPeerRun,
  loadAllMessages,
  loadMessagePage,
  shouldForwardBackgroundThreadEvent,
  shouldForwardPeerThreadEvent,
} from "./thread-message-pages.js";

describe("thread message pages", () => {
  it("names each message's author with one lookup and omits deleted accounts", async () => {
    const row = (id: string, seq: number, authorUserId: string | null, replyTo?: unknown) => ({
      id,
      threadId: "thread-1",
      seq,
      role: "user",
      blocks: [{ kind: "text", text: id }],
      botId: null,
      authorUserId,
      replyToMessageId: replyTo ? "first" : null,
      replyQuote: null,
      replyTo: replyTo ?? null,
      runId: null,
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
    });
    const first = row("first", 1, "user-a");
    const rows = [
      row("gone", 3, "user-deleted"),
      row("reply", 2, "user-b", { ...first, threadId: "thread-1" }),
      first,
    ];
    const users = vi.fn(async (_args: unknown) => [
      { id: "user-a", name: "Ana" },
      { id: "user-b", name: "Bea" },
    ]);
    const prisma = {
      message: { findMany: vi.fn(async () => rows) },
      user: { findMany: users },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(users).toHaveBeenCalledTimes(1);
    expect(users.mock.calls[0]?.[0]).toEqual({
      where: { id: { in: expect.arrayContaining(["user-deleted", "user-b", "user-a"]) } },
      select: { id: true, name: true },
    });
    const byId = new Map(page.messages.map((message) => [message.id, message]));
    expect(byId.get("first")?.author).toEqual({ id: "user-a", name: "Ana" });
    expect(byId.get("reply")?.author).toEqual({ id: "user-b", name: "Bea" });
    expect(byId.get("reply")?.replyPreview?.author).toEqual({ id: "user-a", name: "Ana" });
    expect(byId.get("gone")).not.toHaveProperty("author");
  });

  it("caches peer-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "bot_message" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    await expect(isPeerRun(prisma, "run-peer", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("forwards peer waiting, ask, and text events on an open thread", () => {
    expect(shouldForwardPeerThreadEvent({ type: "run.waiting_input", payload: {} })).toBe(true);
    expect(shouldForwardPeerThreadEvent({ type: "computer.takeover.requested", payload: {} })).toBe(
      true,
    );
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "ask", text: "Pick one" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "peer body" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardPeerThreadEvent({
        type: "thread.progress",
        payload: {},
      }),
    ).toBe(false);
  });

  it.each(["thread.message.created", "thread.message.updated"])(
    "forwards peer charts in %s while keeping background output hidden",
    (type) => {
      const chart = { kind: "chart", name: "Results", spec: {}, data: [] };
      // A page a peer run saved is its reply too.
      const page = { kind: "page", pageId: "page-1", version: 1, title: "Results" };
      for (const blocks of [[chart], [{ kind: "text", text: "Results" }, chart], [page]]) {
        expect(shouldForwardPeerThreadEvent({ type, payload: { blocks } })).toBe(true);
        expect(shouldForwardBackgroundThreadEvent({ type, payload: { blocks } })).toBe(false);
      }
      expect(
        shouldForwardPeerThreadEvent({
          type,
          payload: { blocks: [{ kind: "steps", steps: [{ label: "Tool", count: 1 }] }] },
        }),
      ).toBe(false);
      expect(
        shouldForwardPeerThreadEvent({ type: "thread.progress", payload: { blocks: [chart] } }),
      ).toBe(false);
    },
  );

  it.each([undefined, { seq: 2 }])(
    "keeps peer charts in normal history, including around pages (%s)",
    async (around) => {
      const chart = { kind: "chart", name: "Results", spec: {}, data: [] };
      const rows = [
        { id: "background-chart", runId: "run-background", blocks: [chart] },
        { id: "peer-activity", runId: "run-peer", blocks: [{ kind: "steps", steps: [] }] },
        {
          id: "peer-mixed",
          runId: "run-peer",
          blocks: [{ kind: "text", text: "Results" }, chart],
        },
        { id: "peer-chart", runId: "run-peer", blocks: [chart] },
        {
          id: "peer-page",
          runId: "run-peer",
          blocks: [{ kind: "page", pageId: "page-1", version: 1, title: "Results" }],
        },
      ].map((row, index) => ({
        ...row,
        threadId: "thread-1",
        seq: 5 - index,
        role: "bot",
        botId: "bot-1",
        replyToMessageId: null,
        replyQuote: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      }));
      const prisma = {
        message: {
          findMany: vi.fn(async () => (around ? [...rows].reverse() : rows)),
          count: vi.fn(async () => 0),
        },
        run: {
          findMany: vi.fn(async () => [
            { id: "run-peer", trigger: "bot_message" },
            { id: "run-background", trigger: "tickets" },
          ]),
        },
      } as unknown as PrismaClient;

      const page = await loadMessagePage(prisma, "thread-1", undefined, 5, around);

      expect(page.messages.map((message) => message.id)).toEqual([
        "peer-page",
        "peer-chart",
        "peer-mixed",
      ]);
      expect(page.messages.map((message) => message.blocks)).toEqual([
        rows[4]?.blocks,
        rows[3]?.blocks,
        rows[2]?.blocks,
      ]);
    },
  );

  it.each(["thread.message.created", "thread.message.updated"])(
    "forwards peer attachments but rejects activity for %s",
    (type) => {
      for (const kind of ["file", "image"]) {
        expect(
          shouldForwardPeerThreadEvent({
            type,
            payload: { blocks: [{ kind, artifactId: "artifact-1", name: "attachment" }] },
          }),
        ).toBe(true);
      }
      expect(
        shouldForwardPeerThreadEvent({
          type,
          payload: { blocks: [{ kind: "steps", steps: [{ label: "Tool", count: 1 }] }] },
        }),
      ).toBe(false);
    },
  );

  it("keeps peer file-only and image-only replies on normal pages but drops activity", async () => {
    const rows = [
      { id: "peer-activity", blocks: [{ kind: "steps", steps: [{ label: "Tool", count: 1 }] }] },
      {
        id: "peer-image",
        blocks: [
          { kind: "image", artifactId: "image-1", name: "photo.png", mimeType: "image/png" },
        ],
      },
      {
        id: "peer-file",
        blocks: [
          { kind: "file", artifactId: "file-1", name: "report.txt", mimeType: "text/plain" },
        ],
      },
    ].map((row, index) => ({
      ...row,
      threadId: "thread-1",
      seq: 3 - index,
      role: "bot",
      botId: "bot-1",
      replyToMessageId: null,
      runId: "run-peer",
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    }));
    const prisma = {
      message: { findMany: vi.fn(async () => rows) },
      run: { findMany: vi.fn(async () => [{ id: "run-peer", trigger: "bot_message" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(page.messages.map((message) => message.id)).toEqual(["peer-file", "peer-image"]);
    expect(page.messages.map((message) => message.blocks)).toEqual([
      rows[2]?.blocks,
      rows[1]?.blocks,
    ]);
  });

  it("caches background-run classification for live events", async () => {
    const findUnique = vi.fn(async () => ({ trigger: "tickets" }));
    const prisma = { run: { findUnique } } as unknown as PrismaClient;
    const cache = new Map<string, Promise<boolean>>();

    await expect(isBackgroundRun(prisma, "run-ticket", cache)).resolves.toBe(true);
    await expect(isBackgroundRun(prisma, "run-ticket", cache)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("forwards only explicit user contact from a background run", () => {
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "Working" }] },
      }),
    ).toBe(false);
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "ask", text: "Pick one" }] },
      }),
    ).toBe(true);
    expect(
      shouldForwardBackgroundThreadEvent({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "computer", text: "Needs you" }] },
      }),
    ).toBe(true);
    for (const type of ["thread.message.created", "thread.message.updated"]) {
      expect(
        shouldForwardBackgroundThreadEvent({
          type,
          payload: { blocks: [{ kind: "mcp_approval" }] },
        }),
      ).toBe(true);
    }
    expect(shouldForwardBackgroundThreadEvent({ type: "run.started", payload: {} })).toBe(false);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.waiting_input", payload: {} })).toBe(
      true,
    );
    expect(
      shouldForwardBackgroundThreadEvent({ type: "computer.takeover.requested", payload: {} }),
    ).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.completed", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.failed", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "run.cancelled", payload: {} })).toBe(true);
    expect(shouldForwardBackgroundThreadEvent({ type: "thread.progress", payload: {} })).toBe(
      false,
    );
  });

  it("hides ticket-run output from the transcript but keeps user-input cards", async () => {
    const rows = [
      {
        id: "message-computer",
        blocks: [{ kind: "computer", state: "Needs you", text: "Sign in" }],
      },
      { id: "message-approval", blocks: [{ kind: "mcp_approval" }] },
      { id: "message-final", blocks: [{ kind: "text", text: "Closed the ticket." }] },
      {
        id: "message-steps",
        blocks: [{ kind: "steps", steps: [{ label: "Ticket comment", count: 1 }] }],
      },
      { id: "message-user", blocks: [{ kind: "text", text: "Visible answer" }] },
    ].map((row, index) => ({
      ...row,
      threadId: "thread-1",
      seq: 4 - index,
      role: "bot",
      botId: "bot-1",
      replyToMessageId: null,
      runId: row.id === "message-user" ? "run-user" : "run-ticket",
      clientNonce: null,
      createdAt: new Date("2026-08-16T00:00:01.000Z"),
    }));
    const findMany = vi.fn(async () => rows);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-ticket", trigger: "tickets" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 6);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-approval",
      "message-computer",
    ]);
  });

  it("keeps peer receipt rows when filtering peer-run output from pages", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-reply",
        threadId: "thread-1",
        seq: 3,
        role: "bot",
        blocks: [{ kind: "text", text: "Echoed peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-received",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 3);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-received",
      "message-reply",
    ]);
  });

  it("filters peer-run activity when its receipt is outside the loaded page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
  });

  it("keeps peer text around-page targets and omits peer activity", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-activity",
        threadId: "thread-1",
        seq: 5,
        role: "bot",
        blocks: [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-target",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 1);
    const runFindMany = vi.fn(async () => [{ id: "run-peer" }]);
    const prisma = {
      message: { findMany, count },
      run: { findMany: runFindMany },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-target",
      seq: 6,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-target",
    ]);
    expect(runFindMany).toHaveBeenCalled();
  });

  it("keeps peer receipt and text around-page targets in the normal transcript page", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 4,
        role: "bot",
        blocks: [{ kind: "text", text: "Visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:04.000Z"),
      },
      {
        id: "message-peer-receipt",
        threadId: "thread-1",
        seq: 5,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:05.000Z"),
      },
      {
        id: "message-peer-text",
        threadId: "thread-1",
        seq: 6,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:06.000Z"),
      },
    ]);
    const count = vi.fn(async () => 0);
    const prisma = {
      message: { findMany, count },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, {
      messageId: "message-peer-receipt",
      seq: 5,
    });

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-user",
      "message-peer-receipt",
      "message-peer-text",
    ]);
  });

  it("returns peer-run output for the dedicated bot messages view", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-peer",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Peer reply" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = {
      message: { findMany, count: vi.fn(async () => 0) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(
      prisma,
      "thread-1",
      undefined,
      2,
      { messageId: "message-peer", seq: 1 },
      true,
    );

    expect(page.messages.map((message) => message.id)).toEqual(["message-peer"]);
  });

  it("scans past a page containing only hidden peer-run activity", async () => {
    const row = (seq: number, runId: string, kind: "text" | "steps" = "text") => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks:
        kind === "steps"
          ? [{ kind: "steps", steps: [{ label: String(seq), count: 1 }] }]
          : [{ kind: "text", text: String(seq) }],
      botId: "bot-1",
      replyToMessageId: null,
      runId,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        row(4, "run-peer", "steps"),
        row(3, "run-peer", "steps"),
        row(2, "run-peer", "steps"),
      ])
      .mockResolvedValueOnce([row(1, "run-user")]);
    const prisma = {
      message: { findMany },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-peer" }])
          .mockResolvedValueOnce([]),
      },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-1"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("scans past a receipt-only page so web can reach older user-visible rows", async () => {
    const receiptRows = [
      {
        id: "message-receipt-b",
        threadId: "thread-1",
        seq: 3,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Coder",
            text: "Done.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-peer",
        createdAt: new Date("2026-08-16T00:00:03.000Z"),
      },
      {
        id: "message-receipt-a",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: "bot-2",
            toBotName: "Coder",
            text: "Check this.",
          },
        ],
        botId: null,
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-lookahead",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const olderRows = [
      {
        id: "message-user",
        threadId: "thread-1",
        seq: 1,
        role: "bot",
        blocks: [{ kind: "text", text: "Older visible answer" }],
        botId: "bot-1",
        replyToMessageId: null,
        runId: "run-user",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ];
    const findMany = vi.fn().mockResolvedValueOnce(receiptRows).mockResolvedValueOnce(olderRows);
    const prisma = {
      message: { findMany },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-peer" }])
          .mockResolvedValueOnce([]),
      },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.id)).toEqual(["message-user"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns a receipt-only page when the client displays peer receipts", async () => {
    const receipt = (seq: number) => ({
      id: `message-receipt-${seq}`,
      threadId: "thread-1",
      seq,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Coder",
          text: "Done.",
        },
      ],
      botId: null,
      replyToMessageId: null,
      runId: "run-peer",
      createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
    });
    const findMany = vi.fn(async () => [receipt(3), receipt(2), receipt(1)]);
    const prisma = {
      message: { findMany },
      run: { findMany: vi.fn(async () => [{ id: "run-peer" }]) },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2, undefined, false, true);

    expect(page.messages.map((message) => message.id)).toEqual([
      "message-receipt-2",
      "message-receipt-3",
    ]);
    expect(page.olderCursor).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("queries before the cursor and returns an ascending bounded page", async () => {
    const findMany = vi.fn(async () =>
      [5, 4, 3].map((seq) => ({
        id: `message-${seq}`,
        threadId: "thread-1",
        seq,
        role: "bot",
        blocks: [{ kind: "text", text: String(seq) }],
        runId: null,
        createdAt: new Date(`2026-08-16T00:00:0${seq}.000Z`),
      })),
    );
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 6, 2);

    expect(findMany).toHaveBeenCalledWith({
      include: {
        replyTo: {
          select: { threadId: true, role: true, botId: true, authorUserId: true, blocks: true },
        },
      },
      where: { threadId: "thread-1", seq: { lt: 6 } },
      orderBy: { seq: "desc" },
      take: 3,
    });
    expect(page.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(page.olderCursor).toBe(4);
  });

  it("ends pagination when the database returns no lookahead row", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-0",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        blocks: [],
        runId: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", 1, 2);

    expect(page.messages.map((message) => message.seq)).toEqual([0]);
    expect(page.olderCursor).toBeNull();
  });

  it("loads a page around a target sequence", async () => {
    const findFirst = vi.fn(async () => ({ seq: 5 }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "message-3",
          threadId: "thread-1",
          seq: 3,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-4",
          threadId: "thread-1",
          seq: 4,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
        {
          id: "message-5",
          threadId: "thread-1",
          seq: 5,
          role: "bot",
          blocks: [],
          runId: null,
          createdAt: new Date(),
        },
      ])
      .mockResolvedValueOnce(1);
    const count = vi.fn(async () => 1);
    const prisma = {
      message: { findFirst, findMany, count },
    } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 4, { seq: 5 });

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(page.olderCursor).toBe(3);
    expect(page.coveredThroughSeq).toBe(7);
    expect(findMany).toHaveBeenCalledWith({
      include: {
        replyTo: {
          select: { threadId: true, role: true, botId: true, authorUserId: true, blocks: true },
        },
      },
      where: { threadId: "thread-1", seq: { gte: 3, lte: 7 } },
      orderBy: { seq: "asc" },
      take: 4,
    });
  });

  it("collects bounded pages into chronological export order", async () => {
    const row = (seq: number) => ({
      id: `message-${seq}`,
      threadId: "thread-1",
      seq,
      role: "bot",
      blocks: [],
      runId: null,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([row(4), row(3), row(2)])
      .mockResolvedValueOnce([row(2), row(1), row(0)])
      .mockResolvedValueOnce([row(0)]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const messages = await loadAllMessages(prisma, "thread-1", 2);

    expect(messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(findMany.mock.calls.map(([query]) => query.where.seq?.lt)).toEqual([undefined, 3, 1]);
  });

  it("derives callId from a call client nonce and leaves plain messages without one", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "message-call",
        threadId: "thread-1",
        seq: 2,
        role: "user",
        blocks: [{ kind: "text", text: "Hey" }],
        botId: null,
        replyToMessageId: null,
        replyQuote: null,
        runId: null,
        clientNonce: "call:call-1:abc",
        createdAt: new Date("2026-08-16T00:00:02.000Z"),
      },
      {
        id: "message-plain",
        threadId: "thread-1",
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Typed" }],
        botId: null,
        replyToMessageId: null,
        replyQuote: null,
        runId: null,
        clientNonce: "plain-nonce",
        createdAt: new Date("2026-08-16T00:00:01.000Z"),
      },
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;

    const page = await loadMessagePage(prisma, "thread-1", undefined, 2);

    expect(page.messages.map((message) => message.callId)).toEqual([undefined, "call-1"]);
  });
});

describe("authoritative reply previews", () => {
  it("serializes a parent outside the loaded page and marks deleted parents unavailable", async () => {
    const base = {
      threadId: "thread-1",
      role: "user",
      botId: null,
      runId: null,
      createdAt: new Date(),
      blocks: [{ kind: "text", text: "My reply" }],
    };
    const parent = {
      threadId: "thread-1",
      role: "bot",
      botId: "bot-1",
      blocks: [{ kind: "text", text: "**First** line\n\nSecond line" }],
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        ...base,
        id: "reply-2",
        seq: 2,
        replyToMessageId: null,
        replyQuote: "First line",
        replyTo: null,
      },
      {
        ...base,
        id: "reply-1",
        seq: 1,
        replyToMessageId: "older-parent",
        replyQuote: null,
        replyTo: parent,
      },
    ]);
    const page = await loadMessagePage(
      { message: { findMany } } as unknown as PrismaClient,
      "thread-1",
      undefined,
      100,
    );
    expect(page.messages[0]?.replyPreview).toEqual({
      role: "bot",
      botId: "bot-1",
      text: "First line",
    });
    expect(page.messages[1]?.replyPreview).toBeNull();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1" },
        include: {
          replyTo: {
            select: { threadId: true, role: true, botId: true, authorUserId: true, blocks: true },
          },
        },
      }),
    );
  });
  it("does not expose a parent from another thread", async () => {
    const row = {
      id: "reply",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      blocks: [],
      botId: null,
      runId: null,
      createdAt: new Date(),
      replyToMessageId: "foreign",
      replyQuote: null,
      replyTo: {
        threadId: "other",
        role: "bot",
        botId: "other-bot",
        blocks: [{ kind: "text", text: "Private text" }],
      },
    };
    const page = await loadMessagePage(
      { message: { findMany: vi.fn().mockResolvedValue([row]) } } as unknown as PrismaClient,
      "thread-1",
      undefined,
      100,
    );
    expect(page.messages[0]?.replyPreview).toBeNull();
    expect(JSON.stringify(page)).not.toContain("Private text");
  });
});

describe("reply target validation", () => {
  it.each([
    ["malformed text", [{ kind: "text", text: 12 }], null],
    ["null block", [null], null],
    ["non-array", {}, null],
    ["ask", [{ kind: "ask", text: "Which release?" }], "Which release?"],
    [
      "channel message",
      [
        {
          kind: "channel_message",
          provider: "test",
          channelId: "channel",
          fromAddress: "sender",
          fromLabel: "Sender",
          text: "Release notes",
        },
      ],
      "Release notes",
    ],
    [
      "chart",
      [{ kind: "chart", name: "Release adoption", spec: {}, data: [] }],
      "Release adoption",
    ],
  ])("serializes an outside-page %s target safely", async (_kind, blocks, text) => {
    const row = {
      id: "reply",
      threadId: "thread-1",
      seq: 100,
      role: "user",
      blocks: [{ kind: "text", text: "Follow up" }],
      botId: null,
      runId: null,
      createdAt: new Date("2026-10-08T12:00:00Z"),
      replyToMessageId: "older-parent",
      replyQuote: null,
      replyTo: { id: "older-parent", threadId: "thread-1", role: "bot", botId: "bot-1", blocks },
    };
    const prisma = {
      message: { findMany: vi.fn().mockResolvedValue([row]), count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;
    for (const around of [undefined, { seq: 100 }]) {
      const page = await loadMessagePage(prisma, "thread-1", undefined, 1, around);
      expect(page.messages.map((message) => message.id)).toEqual(["reply"]);
      expect(page.messages[0]?.replyPreview).toEqual(
        text === null ? null : { role: "bot", botId: "bot-1", text },
      );
    }
  });
});

it("derives attachment metadata from a validated parent outside the loaded page", async () => {
  const image = { kind: "image", artifactId: "parent-photo", name: "", mimeType: "image/png" };
  const row = {
    id: "reply",
    threadId: "thread",
    seq: 100,
    role: "user",
    blocks: [],
    botId: null,
    runId: null,
    createdAt: new Date(),
    replyToMessageId: "parent",
    replyQuote: null,
    replyTo: { threadId: "thread", role: "user", botId: null, blocks: [image] },
  };
  const prisma = {
    message: { findMany: vi.fn().mockResolvedValue([row]), count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaClient;
  const page = await loadMessagePage(prisma, "thread", undefined, 1);
  expect(page.messages[0]?.replyPreview).toEqual({ role: "user", text: "", attachment: image });
});
