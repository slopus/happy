import { describe, expect, it, vi } from "vitest";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItems,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "./scratchpad-tools.js";

describe("scratchpad tools store", () => {
  it("lists open and parked items by default and omits done", async () => {
    const findMany = vi.fn(async () => [
      row({ id: "1", title: "Open", status: "open" }),
      row({ id: "2", title: "Parked", status: "parked" }),
    ]);
    const prisma = {
      scratchpadItem: { findMany },
    };

    const items = await listScratchpadItems(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot" },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", botId: "bot", status: { in: ["open", "parked"] } },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    expect(items).toEqual([
      expect.objectContaining({ id: "1", title: "Open", status: "open" }),
      expect.objectContaining({ id: "2", title: "Parked", status: "parked" }),
    ]);
  });

  it("adds an item with trimmed title and default open status", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      row({
        id: "new",
        title: String(data.title),
        status: String(data.status),
        notes: String(data.notes),
      }),
    );
    const prisma = { scratchpadItem: { create } };

    const result = await addScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "  Ship PR  ",
        notes: " after review ",
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "Ship PR",
        status: "open",
        notes: "after review",
      },
    });
    expect(result).toEqual({
      item: expect.objectContaining({ id: "new", title: "Ship PR", status: "open" }),
    });
  });

  it("rejects invalid status on add", async () => {
    const result = await addScratchpadItemFromTool(
      { prisma: { scratchpadItem: { create: vi.fn() } } as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        title: "Nope",
        status: "later",
      },
    );
    expect(result).toEqual({ error: "status must be open, parked, or done." });
  });

  it("updates, completes, and removes scoped items", async () => {
    const existing = row({ id: "item-1", title: "Draft", status: "open" });
    const findFirst = vi.fn(async () => existing);
    const updateManyAndReturn = vi.fn(async ({ data }: { data: Record<string, unknown> }) => [
      row({ ...existing, ...data, status: String(data.status ?? existing.status) }),
    ]);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      scratchpadItem: { findFirst, updateManyAndReturn, deleteMany },
    };

    const updated = await updateScratchpadItemFromTool(
      { prisma: prisma as never },
      {
        spaceId: "ws",
        botId: "bot",
        userId: "user",
        itemId: "item-1",
        title: "Draft v2",
        status: "parked",
      },
    );
    expect(updated).toEqual({
      item: expect.objectContaining({ title: "Draft v2", status: "parked" }),
    });

    const completed = await completeScratchpadItemFromTool(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot", userId: "user", itemId: "item-1" },
    );
    expect(completed).toEqual({
      item: expect.objectContaining({ status: "done" }),
    });

    const removed = await removeScratchpadItemFromTool(
      { prisma: prisma as never },
      { spaceId: "ws", botId: "bot", userId: "user", itemId: "item-1" },
    );
    expect(removed).toEqual({ ok: true, itemId: "item-1", title: "Draft" });
    const scope = { id: "item-1", spaceId: "ws", botId: "bot" };
    expect(findFirst).toHaveBeenCalledWith({ where: scope });
    expect(updateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
    expect(deleteMany).toHaveBeenCalledWith({ where: scope });
  });

  it("reports not found when the item leaves the scope before the write", async () => {
    const existing = row({ id: "item-1", title: "Draft", status: "open" });
    const prisma = {
      scratchpadItem: {
        findFirst: vi.fn(async () => existing),
        updateManyAndReturn: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const input = { spaceId: "ws", botId: "bot", userId: "user", itemId: "item-1" };
    await expect(
      updateScratchpadItemFromTool({ prisma: prisma as never }, { ...input, title: "x" }),
    ).resolves.toEqual({ error: "Scratchpad item not found." });
    await expect(removeScratchpadItemFromTool({ prisma: prisma as never }, input)).resolves.toEqual(
      { error: "Scratchpad item not found." },
    );
  });

  it("returns not found when item is outside the bot scope", async () => {
    const prisma = {
      scratchpadItem: { findFirst: vi.fn(async () => null) },
    };
    await expect(
      updateScratchpadItemFromTool(
        { prisma: prisma as never },
        {
          spaceId: "ws",
          botId: "bot",
          userId: "user",
          itemId: "missing",
          title: "x",
        },
      ),
    ).resolves.toEqual({ error: "Scratchpad item not found." });
  });

  it("lists via tool wrapper", async () => {
    const findMany = vi.fn(async () => [row({ id: "1", title: "Open", status: "open" })]);
    const result = await listScratchpadItemsFromTool(
      { prisma: { scratchpadItem: { findMany } } as never },
      { spaceId: "ws", botId: "bot" },
    );
    expect(result.items).toHaveLength(1);
  });
});

function row(partial: {
  id: string;
  title: string;
  status: string;
  notes?: string;
  botId?: string;
}) {
  const now = new Date("2026-08-25T12:00:00.000Z");
  return {
    id: partial.id,
    botId: partial.botId ?? "bot",
    title: partial.title,
    status: partial.status,
    notes: partial.notes ?? "",
    createdAt: now,
    updatedAt: now,
  };
}
