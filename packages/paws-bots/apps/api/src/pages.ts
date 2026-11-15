import { createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { forgetPageShareSecrets } from "@rakazo/adapters";
import type { Actor, PageDetail, PageSummary, PageVisibility, SharedPage } from "@rakazo/contracts";
import { pageShareTokenFromSlug, pageShareUrl } from "@rakazo/contracts";
import { escapeSearchWildcards } from "@rakazo/core";
import type { PageShareSecret, Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, isRecordNotFound, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const PAGE_SHARE_SECRET_KIND = "page_share";
const DEFAULT_LIST_LIMIT = 30;

type PageDeps = { prisma: PrismaClient; secrets: SecretStore; webOrigin: string };

const summarySelect = {
  id: true,
  title: true,
  botId: true,
  groupId: true,
  visibility: true,
  currentVersion: true,
  pinnedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PageSelect;

type SummaryRow = Prisma.PageGetPayload<{ select: typeof summarySelect }>;

function pageSummary(row: SummaryRow): PageSummary {
  return {
    id: row.id,
    title: row.title,
    botId: row.botId,
    groupId: row.groupId,
    visibility: row.visibility === "link" ? "link" : "private",
    currentVersion: row.currentVersion,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function hashPageShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A page deleted between the ownership read and the write, by another tab, reads as gone. */
async function stillThere<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new IsolationError();
    }
    throw error;
  }
}

async function requirePage(prisma: PrismaClient, actor: Actor, pageId: string) {
  const row = await prisma.page.findFirst({
    where: { id: pageId, spaceId: actor.spaceId, userId: actor.userId },
    select: { ...summarySelect, shareSecretId: true },
  });
  if (!row) throw new IsolationError();
  return row;
}

export class PageListCursorError extends Error {
  constructor() {
    super("Invalid page list cursor");
  }
}

type ListCursor = { pinnedAt: string | null; updatedAt: string; id: string };

function encodeCursor(row: SummaryRow): string {
  const cursor: ListCursor = {
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ListCursor;
    const valid =
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.updatedAt)) &&
      (parsed.pinnedAt === null || !Number.isNaN(Date.parse(parsed.pinnedAt)));
    if (valid) return parsed;
  } catch {}
  throw new PageListCursorError();
}

/** Rows after the cursor in (pinned first by pin time, then newest update, then id) order. */
function afterCursor(cursor: ListCursor): Prisma.PageWhereInput {
  const updatedAt = new Date(cursor.updatedAt);
  const sameUpdate: Prisma.PageWhereInput = {
    OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: cursor.id } }],
  };
  if (cursor.pinnedAt === null) return { pinnedAt: null, ...sameUpdate };
  const pinnedAt = new Date(cursor.pinnedAt);
  return {
    OR: [{ pinnedAt: null }, { pinnedAt: { lt: pinnedAt } }, { pinnedAt, ...sameUpdate }],
  };
}

export async function listPages(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string; cursor?: string; limit?: number; query?: string },
) {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  const where: Prisma.PageWhereInput = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.botId ? { botId: input.botId, ...(input.groupId ? {} : { groupId: null }) } : {}),
    ...(input.cursor ? { AND: [afterCursor(decodeCursor(input.cursor))] } : {}),
    ...(input.query
      ? { title: { contains: escapeSearchWildcards(input.query), mode: "insensitive" } }
      : {}),
  };
  const rows = await prisma.page.findMany({
    where,
    select: summarySelect,
    orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(pageSummary),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

async function shareUrlFor(
  deps: PageDeps,
  row: { title: string; visibility: string; shareSecretId: string | null },
): Promise<string | null> {
  if (row.visibility !== "link" || !row.shareSecretId) return null;
  const secret = await deps.prisma.secret.findUnique({
    where: { id: row.shareSecretId },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return null;
  const token = await deps.secrets.load(secret.ciphertext, { recordId: secret.id });
  return pageShareUrl(deps.webOrigin, row.title, token);
}

export async function getPage(
  deps: PageDeps,
  actor: Actor,
  input: { pageId: string; version?: number; link?: boolean },
): Promise<PageDetail> {
  const row = await requirePage(deps.prisma, actor, input.pageId);
  const version = input.version ?? row.currentVersion;
  const [stored, owner] = await Promise.all([
    deps.prisma.pageVersion.findUnique({
      where: { pageId_version: { pageId: row.id, version } },
      select: { code: true },
    }),
    deps.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { name: true, image: true },
    }),
  ]);
  if (!stored) throw new IsolationError();
  return {
    ...pageSummary(row),
    version,
    code: stored.code,
    owner: { name: owner?.name ?? "", image: owner?.image ?? null },
    // Cards skip the secret store; a token it cannot read hides only the link.
    shareUrl: input.link
      ? await shareUrlFor(deps, row).catch((error: unknown) => {
          getLogger().error("page link token load", error);
          return null;
        })
      : null,
  };
}

export async function renamePage(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
  title: string,
) {
  await requirePage(prisma, actor, pageId);
  return pageSummary(
    await stillThere(
      prisma.page.update({
        where: { id: pageId },
        data: { title, updatedAt: new Date() },
        select: summarySelect,
      }),
    ),
  );
}

export async function pinPage(prisma: PrismaClient, actor: Actor, pageId: string, pinned: boolean) {
  const row = await requirePage(prisma, actor, pageId);
  if ((row.pinnedAt !== null) === pinned) return pageSummary(row);
  return pageSummary(
    await stillThere(
      prisma.page.update({
        where: { id: pageId },
        data: { pinnedAt: pinned ? new Date() : null },
        select: summarySelect,
      }),
    ),
  );
}

export class PageShareConflictError extends Error {
  constructor() {
    super("The page's sharing changed at the same time; try again");
  }
}

/**
 * Compare-and-swap on the link, so concurrent changes never both win or orphan a sealed token.
 * Turning on a page that already has a link keeps that link (`kept`), so two turn-ons at once
 * both hand out the one URL that works, unless that link is `next.unreadable`: its token can't
 * be loaded, so it is replaced. `replaced` is the secret a swap deleted, for the caller to remove
 * from the secret store once committed.
 */
async function swapPageShare(
  prisma: PrismaClient,
  pageId: string,
  next: {
    tokenHash: string;
    secret: { id: string; data: Prisma.SecretUncheckedCreateInput };
    unreadable: string | null;
  } | null,
): Promise<{ kept: boolean; replaced: PageShareSecret | null }> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await prisma
      .$transaction(async (tx) => {
        const current = await tx.page.findUnique({
          where: { id: pageId },
          select: { shareSecretId: true },
        });
        if (!current) throw new IsolationError();
        if (next && current.shareSecretId && current.shareSecretId !== next.unreadable) {
          return { kept: true, replaced: null };
        }
        if (next) await tx.secret.create({ data: next.secret.data });
        const moved = await tx.page.updateMany({
          where: { id: pageId, shareSecretId: current.shareSecretId },
          data: next
            ? { visibility: "link", shareTokenHash: next.tokenHash, shareSecretId: next.secret.id }
            : { visibility: "private", shareTokenHash: null, shareSecretId: null },
        });
        // Rolling back drops the new secret with the failed swap.
        if (moved.count === 0) throw new PageShareConflictError();
        if (!current.shareSecretId) return { kept: false, replaced: null };
        const replaced = await tx.secret.findUnique({
          where: { id: current.shareSecretId },
          select: { id: true, ciphertext: true },
        });
        await tx.secret.deleteMany({ where: { id: current.shareSecretId } });
        return { kept: false, replaced };
      })
      .catch((error: unknown) => {
        if (error instanceof PageShareConflictError && attempt === 0) return null;
        throw error;
      });
    if (outcome) return outcome;
  }
}

/**
 * A fresh token when the page has no live link, so a link shared before it was turned off stays
 * dead. Turning on a page that already has a link returns that link, or replaces it when its
 * token can't be read, so the owner always gets a link they can copy.
 */
export async function setPageVisibility(
  deps: PageDeps,
  actor: Actor,
  input: { pageId: string; visibility: PageVisibility },
  signal: AbortSignal,
): Promise<{ visibility: PageVisibility; shareUrl: string | null }> {
  const row = await requirePage(deps.prisma, actor, input.pageId);
  if (input.visibility === "private") {
    const { replaced } = await swapPageShare(deps.prisma, row.id, null);
    if (replaced) await forgetPageShareSecrets(deps.secrets, [replaced]);
    return { visibility: "private", shareUrl: null };
  }
  let unreadable: string | null = null;
  const existing = await shareUrlFor(deps, row).catch((error: unknown) => {
    getLogger().error("page link token load", error);
    unreadable = row.shareSecretId;
    return null;
  });
  if (existing) return { visibility: "link", shareUrl: existing };
  const token = randomBytes(32).toString("base64url");
  const stored = await deps.secrets.put(token, {
    operationId: `page-share:${row.id}`,
    traceId: `page-share:${row.id}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal,
  });
  let swapped: Awaited<ReturnType<typeof swapPageShare>>;
  try {
    swapped = await swapPageShare(deps.prisma, row.id, {
      tokenHash: hashPageShareToken(token),
      secret: {
        id: stored.id,
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: PAGE_SHARE_SECRET_KIND,
          ciphertext: stored.ciphertext,
        },
      },
      unreadable,
    });
  } catch (error) {
    await forgetPageShareSecrets(deps.secrets, [stored]);
    throw error;
  }
  if (swapped.kept) {
    // Another turn-on won while this one sealed its token: both callers get the winner's link.
    await forgetPageShareSecrets(deps.secrets, [stored]);
    const winner = await shareUrlFor(deps, await requirePage(deps.prisma, actor, row.id));
    if (winner) return { visibility: "link", shareUrl: winner };
    throw new PageShareConflictError();
  }
  if (swapped.replaced) await forgetPageShareSecrets(deps.secrets, [swapped.replaced]);
  return { visibility: "link", shareUrl: pageShareUrl(deps.webOrigin, row.title, token) };
}

export async function removePage(deps: PageDeps, actor: Actor, pageId: string) {
  const row = await requirePage(deps.prisma, actor, pageId);
  const removed = await deps.prisma.$transaction(async (tx) => {
    // The deleted row's link, not the one read before: a share may have swapped it since.
    const deleted = await stillThere(
      tx.page.delete({ where: { id: row.id }, select: { shareSecretId: true } }),
    );
    if (!deleted.shareSecretId) return null;
    const secret = await tx.secret.findUnique({
      where: { id: deleted.shareSecretId },
      select: { id: true, ciphertext: true },
    });
    await tx.secret.deleteMany({ where: { id: deleted.shareSecretId } });
    return secret;
  });
  if (removed) await forgetPageShareSecrets(deps.secrets, [removed]);
  return { ok: true as const };
}

/** The current version of a page shared by link, or null for any token that does not open one. */
export async function readSharedPage(
  prisma: PrismaClient,
  token: string,
): Promise<SharedPage | null> {
  if (pageShareTokenFromSlug(token) !== token) return null;
  const page = await runAsSystem("page share link", () =>
    prisma.page.findUnique({
      where: { shareTokenHash: hashPageShareToken(token) },
      select: {
        visibility: true,
        title: true,
        currentVersion: true,
        updatedAt: true,
        id: true,
        shareSecretId: true,
      },
    }),
  );
  // A link lives only while its sealed token does, whatever removed the token.
  if (page?.visibility !== "link" || !page.shareSecretId) return null;
  const version = await runAsSystem("page share link", () =>
    prisma.pageVersion.findUnique({
      where: { pageId_version: { pageId: page.id, version: page.currentVersion } },
      select: { code: true },
    }),
  );
  if (!version) return null;
  return {
    title: page.title,
    code: version.code,
    version: page.currentVersion,
    updatedAt: page.updatedAt.toISOString(),
  };
}
