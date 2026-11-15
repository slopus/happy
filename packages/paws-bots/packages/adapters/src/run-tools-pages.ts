import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH, PageTitleSchema } from "@rakazo/contracts";
import { CARD_TITLE_ESCAPED_CHARACTERS, containsSecret, redactSecrets } from "@rakazo/core";
import { isUniqueViolation } from "@rakazo/db";
import { checkPageSource, PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { MAX_APPROVAL_DETAIL_LENGTH } from "./approval-ask.js";
import type { RunContext } from "./run-context.js";
import { markReadOutsideContent, neverAsks } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { argumentGiven } from "./update-bot-patch.js";

const MAX_EDITS = 50;

type PageEdit = { find: string; replace: string };

/** All edits or none: each `find` must occur exactly once in the result of the edits before it. */
function applyPageEdits(
  source: string,
  edits: readonly PageEdit[],
): { ok: true; source: string } | { ok: false; error: string } {
  let next = source;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (!edit.find) return { ok: false, error: `${label}: find is empty.` };
    const at = next.indexOf(edit.find);
    if (at === -1) return { ok: false, error: `${label}: find text was not found in the page.` };
    if (next.indexOf(edit.find, at + 1) !== -1) {
      return {
        ok: false,
        error: `${label}: find text occurs more than once; include more surrounding text.`,
      };
    }
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return { ok: true, source: next };
}

function parseEdits(value: unknown): PageEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return "edits must be a non-empty list.";
  if (value.length > MAX_EDITS) return `Send at most ${MAX_EDITS} edits at once.`;
  const edits: PageEdit[] = [];
  for (const [index, item] of value.entries()) {
    const edit = item as Partial<PageEdit> | null;
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") {
      return `Edit ${index + 1}: needs find and replace strings.`;
    }
    edits.push({ find: edit.find, replace: edit.replace });
  }
  return edits;
}

/**
 * A bot reaches its own pages and its group's pages, from any of its chats or routines; another
 * bot's page answers as if it did not exist, since its source may hold that chat's text.
 */
function reachablePage(ctx: RunContext, pageId: string) {
  const { run, bot, thread } = ctx;
  return {
    id: pageId,
    spaceId: run.spaceId,
    userId: run.userId,
    OR: thread.groupId ? [{ botId: bot.id }, { groupId: thread.groupId }] : [{ botId: bot.id }],
  };
}

function editsGiven(args: Record<string, unknown>): boolean {
  // Serializers send unused optional fields blank, an empty list included.
  return Array.isArray(args.edits) ? args.edits.length > 0 : argumentGiven(args.edits);
}

/** The page a save would store: the given source, or the current source with the edits applied. */
function proposedSource(
  current: string,
  args: Record<string, unknown>,
): { ok: true; source: string } | { ok: false; error: string } {
  if (!editsGiven(args))
    return { ok: true, source: argumentGiven(args.source) ? String(args.source) : current };
  const edits = parseEdits(args.edits);
  return typeof edits === "string" ? { ok: false, error: edits } : applyPageEdits(current, edits);
}

/** Text kept on each side of a change inside a line, so the card shows where it is. */
const CHANGE_CONTEXT = 40;

/**
 * What changes, without what both versions share: whole lines at the start and end, then
 * characters inside the changed lines, keeping a little context around the change.
 */
function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  const next = after.split("\n");
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const removed = old.slice(start, old.length - end).join("\n");
  const added = next.slice(start, next.length - end).join("\n");
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  )
    tail++;
  const cut = Math.max(0, head - CHANGE_CONTEXT);
  const keep = Math.max(0, tail - CHANGE_CONTEXT);
  const shorten = (text: string) =>
    `${cut ? "…" : ""}${text.slice(cut, text.length - keep)}${keep ? "…" : ""}`;
  const block = (lineCount: number, text: string, sign: string) =>
    lineCount
      ? shorten(text)
          .split("\n")
          .map((line) => `${sign} ${line}`)
      : [];
  return [
    ...block(old.length - end - start, removed, "-"),
    ...block(next.length - end - start, added, "+"),
  ];
}

/**
 * Anyone with a shared page's link sees each save at once, so a save to one is held for approval,
 * except under Never ask. The card shows every line that changes, and the approval holds the
 * version it was shown against. A save that would fail anyway is not held: it fails as it would.
 * An approved replay stays held so it claims the approval it was given.
 */
export async function holdSharedPageSave(
  ctx: RunContext,
  request: ToolRequest,
): Promise<{ error: string } | undefined> {
  if (request.nextApprovedTool === "save_page") {
    request.heldForApproval = true;
    return undefined;
  }
  // Only a card the user approved pins a version.
  const { approvedVersion: _ignored, ...args } = request.args;
  request.args = args;
  request.effectRequest = args;
  if (args.help === true || !argumentGiven(args.pageId)) return undefined;
  const hasTitle = argumentGiven(args.title);
  if (!argumentGiven(args.source) && !editsGiven(args) && !hasTitle) return undefined;
  if (argumentGiven(args.source) && editsGiven(args)) return undefined;
  if (await neverAsks(ctx)) return undefined;
  const page = await ctx.deps.prisma.page.findFirst({
    where: reachablePage(ctx, String(args.pageId)),
    select: {
      title: true,
      visibility: true,
      currentVersion: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { source: true } },
    },
  });
  if (page?.visibility !== "link") return undefined;
  const parsedTitle = hasTitle ? PageTitleSchema.safeParse(args.title) : undefined;
  if (parsedTitle && !parsedTitle.success) return undefined;
  const current = page.versions[0]?.source ?? "";
  const proposed = proposedSource(current, args);
  if (!proposed.ok) return undefined;
  const check = checkPageSource(proposed.source);
  if (!check.ok || containsSecret([proposed.source, check.code], ctx.secrets)) return undefined;
  const lines = [
    // The title as it would be stored.
    ...(parsedTitle
      ? [`Title: ${redactSecrets(parsedTitle.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH)}`]
      : []),
    ...changedLines(current, proposed.source),
  ];
  // Measured as the card shows it, redacted, so nothing an approval covers is cut off.
  if (redactSecrets(lines.join("\n"), ctx.secrets).length > MAX_APPROVAL_DETAIL_LENGTH)
    return {
      error:
        "This page is shared by link, and this change is too long to show the user for approval. Save it as several smaller edits.",
    };
  const title = page.title.replace(new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"), "\\$&");
  request.args = { ...args, approvedVersion: page.currentVersion };
  request.effectRequest = request.args;
  request.heldForApproval = true;
  request.fleetSummary = { title: `Update shared page “${title}”?`, lines };
  return undefined;
}

async function savePage(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread } = ctx;
  const { args } = call;
  if (args.help === true) return { guide: PAGE_KIT_GUIDE };
  const pageId = argumentGiven(args.pageId) ? String(args.pageId) : undefined;
  const hasSource = argumentGiven(args.source);
  const hasEdits = editsGiven(args);
  if (hasSource && hasEdits) return { error: "Send either source or edits, not both." };
  let title: string | undefined;
  if (argumentGiven(args.title)) {
    const parsed = PageTitleSchema.safeParse(args.title);
    if (!parsed.success) return { error: "title must be 1 to 200 characters." };
    title = redactSecrets(parsed.data, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
  }

  const page = pageId
    ? await deps.prisma.page.findFirst({
        where: reachablePage(ctx, pageId),
        select: {
          id: true,
          title: true,
          visibility: true,
          currentVersion: true,
          versions: { orderBy: { version: "desc" }, take: 1, select: { source: true } },
        },
      })
    : null;
  if (pageId && !page) return { error: "No page with that pageId belongs to this bot or chat." };
  const current = page?.versions[0]?.source ?? "";

  if (page && !hasSource && !hasEdits && !title) {
    // The stored source may hold outside text an earlier run put in the page, so reading it
    // taints this run like any other outside content; saves only confirm this run's own write.
    await markReadOutsideContent(ctx);
    return {
      pageId: page.id,
      version: page.currentVersion,
      title: page.title,
      ...(page.visibility === "link" ? { sharedByLink: true } : {}),
      source: current,
    };
  }
  if (!page && hasEdits) return { error: "edits need the pageId of the page to change." };
  if (!page && !hasSource) return { error: "A new page needs source." };
  if (!page && !title) return { error: "A new page needs a title." };

  // An approved change applies only to the version the user saw it against.
  if (page && args.approvedVersion !== undefined && args.approvedVersion !== page.currentVersion)
    return { error: "The page changed while saving; read it again and retry.", unchanged: true };
  const proposed = proposedSource(current, args);
  if (!proposed.ok) return { error: proposed.error, unchanged: true };
  const { source } = proposed;
  const check = checkPageSource(source);
  if (!check.ok) {
    return { error: "The page has problems; nothing was saved.", problems: check.errors };
  }
  // A page can be shared by link, so it never stores a value this run keeps secret.
  if (containsSecret([source, check.code], ctx.secrets)) {
    return {
      error: "The page contains a secret value; nothing was saved. Remove it and save again.",
      unchanged: true,
    };
  }

  const unapproved =
    page !== null &&
    !call.bypassApproval &&
    call.nextApprovedTool !== "save_page" &&
    !(await neverAsks(ctx));
  let saved: { pageId: string; version: number; title: string };
  try {
    saved = await deps.prisma.$transaction(async (tx) => {
      if (!page) {
        const created = await tx.page.create({
          data: {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: bot.id,
            groupId: thread.groupId,
            title: title!,
            versions: { create: { version: 1, title: title!, source, code: check.code } },
          },
        });
        return { pageId: created.id, version: 1, title: created.title };
      }
      const version = page.currentVersion + 1;
      // Conditional on the version this change was built from, so two saves never interleave.
      // A save nobody approved also needs the page still private: sharing does not bump the
      // version, so a page shared since the approval check would publish it.
      // With no new title the page keeps its current one, even a rename made after the read.
      const moved = await tx.page.updateMany({
        where: {
          id: page.id,
          currentVersion: page.currentVersion,
          ...(unapproved ? { visibility: "private" } : {}),
        },
        data: { currentVersion: version, title, updatedAt: new Date() },
      });
      if (moved.count === 0) throw new PageChangedError();
      let nextTitle =
        title ??
        (await tx.page.findUniqueOrThrow({ where: { id: page.id }, select: { title: true } }))
          .title;
      // A title saved before this run learned a secret is redacted before it is shown again.
      const kept = redactSecrets(nextTitle, ctx.secrets).slice(0, PAGE_TITLE_MAX_LENGTH);
      if (kept !== nextTitle) {
        nextTitle = kept;
        await tx.page.update({ where: { id: page.id }, data: { title: kept } });
      }
      await tx.pageVersion.create({
        data: { pageId: page.id, version, title: nextTitle, source, code: check.code },
      });
      return { pageId: page.id, version, title: nextTitle };
    });
  } catch (error) {
    if (error instanceof PageChangedError || isUniqueViolation(error)) {
      return { error: "The page changed while saving; read it again and retry.", unchanged: true };
    }
    throw error;
  }
  const block: MessageBlock = { kind: "page", ...saved };
  const linkText = saved.title.replace(/[\\[\]]/g, "\\$&");
  try {
    // A routine speaks only through its final reply, which may be silence, so refreshing a
    // page it already showed posts no card; its first save still does.
    if (!page || run.trigger !== "routine") await publishMessage(deps, run, "bot", [block]);
  } catch (error) {
    // The page is saved; only its card in the chat is missing, so the bot can still link it.
    return {
      ...saved,
      error: `The page was saved, but its card could not be posted in the chat (${
        error instanceof Error ? error.message : "unknown error"
      }). Link it in your reply as [${linkText}](page:${saved.pageId}).`,
    };
  }
  const result = {
    ...saved,
    ...(page?.visibility === "link" ? { sharedByLink: true } : {}),
    mention: `Mention it in your reply as [${linkText}](page:${saved.pageId})`,
  };
  return check.warnings?.length ? { ...result, warnings: check.warnings } : result;
}

class PageChangedError extends Error {}

export const pageTools: ToolHandlers = {
  async save_page(ctx, call) {
    return call.finish(await savePage(ctx, call));
  },
};
