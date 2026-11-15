import type { PrismaClient } from "@rakazo/db";

export const SCRATCHPAD_STATUSES = ["open", "parked", "done"] as const;
export type ScratchpadStatus = (typeof SCRATCHPAD_STATUSES)[number];

export const OPEN_SCRATCHPAD_STATUSES: ScratchpadStatus[] = ["open", "parked"];

export const SCRATCHPAD_TITLE_MAX_LENGTH = 200;
export const SCRATCHPAD_NOTES_MAX_LENGTH = 4_000;

export type ScratchpadToolDeps = {
  prisma: PrismaClient;
};

export type ScratchpadRow = {
  id: string;
  botId: string;
  title: string;
  status: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

export function mapScratchpadItem(row: ScratchpadRow) {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    status: coerceScratchpadStatus(row.status),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isScratchpadStatus(value: unknown): value is ScratchpadStatus {
  return typeof value === "string" && (SCRATCHPAD_STATUSES as readonly string[]).includes(value);
}

export function coerceScratchpadStatus(value: unknown): ScratchpadStatus {
  return isScratchpadStatus(value) ? value : "open";
}

export async function listScratchpadItems(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    status?: ScratchpadStatus;
    includeDone?: boolean;
  },
) {
  const statusFilter = input.status
    ? { status: input.status }
    : input.includeDone
      ? {}
      : { status: { in: OPEN_SCRATCHPAD_STATUSES } };
  const rows = await deps.prisma.scratchpadItem.findMany({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      ...statusFilter,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(mapScratchpadItem);
}

export async function addScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status?: string;
    notes?: string;
  },
) {
  const title = input.title.trim();
  if (!title) return { error: "title is required." };
  if (title.length > SCRATCHPAD_TITLE_MAX_LENGTH)
    return { error: `title must be at most ${SCRATCHPAD_TITLE_MAX_LENGTH} characters.` };
  const notes = (input.notes ?? "").trim();
  if (notes.length > SCRATCHPAD_NOTES_MAX_LENGTH)
    return { error: `notes must be at most ${SCRATCHPAD_NOTES_MAX_LENGTH} characters.` };

  let status: ScratchpadStatus = "open";
  if (input.status !== undefined) {
    if (!isScratchpadStatus(input.status)) {
      return { error: "status must be open, parked, or done." };
    }
    status = input.status;
  }

  const row = await deps.prisma.scratchpadItem.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      title,
      status,
      notes,
    },
  });
  return { item: mapScratchpadItem(row) };
}

/** Items are the bot's, shared by every member of its space. */
function scratchpadItemScope(input: { spaceId: string; botId: string }, id: string) {
  return { id, spaceId: input.spaceId, botId: input.botId };
}

export async function updateScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
    title?: string;
    status?: string;
    notes?: string;
  },
) {
  const itemId = input.itemId.trim();
  if (!itemId) return { error: "itemId is required." };

  const existing = await deps.prisma.scratchpadItem.findFirst({
    where: scratchpadItemScope(input, itemId),
  });
  if (!existing) return { error: "Scratchpad item not found." };

  const data: { title?: string; status?: string; notes?: string } = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { error: "title cannot be empty." };
    if (title.length > SCRATCHPAD_TITLE_MAX_LENGTH)
      return { error: `title must be at most ${SCRATCHPAD_TITLE_MAX_LENGTH} characters.` };
    data.title = title;
  }
  if (input.status !== undefined) {
    if (!isScratchpadStatus(input.status)) {
      return { error: "status must be open, parked, or done." };
    }
    data.status = input.status;
  }
  if (input.notes !== undefined) {
    const notes = input.notes.trim();
    if (notes.length > SCRATCHPAD_NOTES_MAX_LENGTH)
      return { error: `notes must be at most ${SCRATCHPAD_NOTES_MAX_LENGTH} characters.` };
    data.notes = notes;
  }
  if (Object.keys(data).length === 0) {
    return { error: "Provide title, status, and/or notes to update." };
  }

  // The scope is part of the write, so the item cannot change hands between the read and it.
  const [row] = await deps.prisma.scratchpadItem.updateManyAndReturn({
    where: scratchpadItemScope(input, existing.id),
    data,
  });
  if (!row) return { error: "Scratchpad item not found." };
  return { item: mapScratchpadItem(row) };
}

export async function completeScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
  },
) {
  return updateScratchpadItemFromTool(deps, {
    ...input,
    status: "done",
  });
}

export async function removeScratchpadItemFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    itemId: string;
  },
) {
  const itemId = input.itemId.trim();
  if (!itemId) return { error: "itemId is required." };

  const existing = await deps.prisma.scratchpadItem.findFirst({
    where: scratchpadItemScope(input, itemId),
  });
  if (!existing) return { error: "Scratchpad item not found." };

  const { count } = await deps.prisma.scratchpadItem.deleteMany({
    where: scratchpadItemScope(input, existing.id),
  });
  if (count === 0) return { error: "Scratchpad item not found." };
  return { ok: true as const, itemId: existing.id, title: existing.title };
}

export async function listScratchpadItemsFromTool(
  deps: ScratchpadToolDeps,
  input: {
    spaceId: string;
    botId: string;
    includeDone?: boolean;
  },
) {
  const items = await listScratchpadItems(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
    includeDone: input.includeDone,
  });
  return { items };
}
