import { ORPCError } from "@orpc/server";
import { commentTicket, createTicket, updateTicket } from "@rakazo/adapters";
import { parseTicketRef } from "@rakazo/contracts";
import { escapeSearchWildcards } from "@rakazo/core";
import type { Board as BoardRow, Prisma, PrismaClient } from "@rakazo/db";
import {
  ensureBoard,
  findTicket,
  IsolationError,
  listBoards,
  listTicketComments,
  toBoardDto,
  toTicketCommentDto,
  toTicketDto,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";
import { HEARTBEAT, withHeartbeats } from "./shared.js";

async function resolveSpaceBoard(
  prisma: PrismaClient,
  spaceId: string,
  boardId?: string,
): Promise<BoardRow> {
  const board = await ensureBoard(prisma, spaceId);
  if (boardId === undefined || boardId === board.id) return board;
  const found = await prisma.board.findFirst({ where: { id: boardId, spaceId } });
  if (!found) throw new ORPCError("BAD_REQUEST", { message: "Unknown board." });
  return found;
}

export function boardsRoutes(ctx: RouterContext) {
  const { deps, repos, boardEnabled, ticketDeps } = ctx;
  return {
    boards: {
      list: boardEnabled.boards.list.handler(async ({ context }) => {
        await ensureBoard(deps.prisma, context.actor.spaceId);
        const rows = await listBoards(deps.prisma, context.actor.spaceId);
        return rows.map(toBoardDto);
      }),
      get: boardEnabled.boards.get.handler(async ({ context }) => {
        const board = await ensureBoard(deps.prisma, context.actor.spaceId);
        return toBoardDto(board);
      }),
      rename: boardEnabled.boards.rename.handler(async ({ context, input }) => {
        const board = await ensureBoard(deps.prisma, context.actor.spaceId);
        const nextPrefix = input.ticketPrefix?.toUpperCase();
        const changesPrefix = nextPrefix !== undefined && nextPrefix !== board.ticketPrefix;
        if (changesPrefix) {
          const tickets = await deps.prisma.ticket.count({
            where: { boardId: board.id, spaceId: context.actor.spaceId },
          });
          if (tickets > 0) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Cannot change the ticket prefix once tickets exist.",
            });
          }
        }
        // Only a changed prefix is written: replaying a case-only value could
        // restore a prefix that a concurrent rename already replaced.
        const data = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(changesPrefix ? { ticketPrefix: nextPrefix } : {}),
        };
        let row: BoardRow;
        if (changesPrefix) {
          // The write itself must still require an empty board: createTicket
          // commits its first insert after this count ran, so only this check
          // stops the prefix from retroactively changing existing ticket refs.
          // nextNumber closes the lock-wait gap: createTicket's transaction
          // increments this same row, and Postgres rechecks a scalar predicate
          // against the committed row, while the tickets subquery can keep its
          // pre-wait snapshot and miss the inserted ticket.
          const [updated] = await deps.prisma.board.updateManyAndReturn({
            where: {
              id: board.id,
              spaceId: context.actor.spaceId,
              nextNumber: board.nextNumber,
              tickets: { none: {} },
            },
            data,
          });
          if (!updated) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Cannot change the ticket prefix once tickets exist.",
            });
          }
          row = updated;
        } else {
          row = await deps.prisma.board.update({ where: { id: board.id }, data });
        }
        return toBoardDto(row);
      }),
      subscribe: boardEnabled.boards.subscribe.handler(async function* ({ context }) {
        const spaceId = context.actor.spaceId;
        // Board signals are transient, so a heartbeat stands in for liveness and
        // gives the client a periodic catch-up reload if a push was missed.
        const events = withHeartbeats(context, (signal) =>
          deps.boardEvents.follow(spaceId, signal),
        );
        for await (const next of events) {
          yield next === HEARTBEAT ? { spaceId, createdAt: new Date().toISOString() } : next;
        }
      }),
    },
    tickets: {
      list: boardEnabled.tickets.list.handler(async ({ context, input }) => {
        const board = await resolveSpaceBoard(deps.prisma, context.actor.spaceId, input.boardId);
        const q = input.q?.trim();
        // The database side has to match the text the user typed: a `%` or `_`
        // would otherwise widen the match, and a `\` would swallow the
        // character after it.
        const likeQ = q ? escapeSearchWildcards(q) : q;
        const where: Prisma.TicketWhereInput = {
          spaceId: context.actor.spaceId,
          boardId: board.id,
          ...(input.status ? { status: input.status } : {}),
          ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
          ...(q
            ? {
                OR: [
                  { title: { contains: likeQ, mode: "insensitive" } },
                  { description: { contains: likeQ, mode: "insensitive" } },
                ],
              }
            : {}),
        };
        const rows = await deps.prisma.ticket.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });
        return { tickets: rows.map((row) => toTicketDto(row, board.ticketPrefix)) };
      }),
      get: boardEnabled.tickets.get.handler(async ({ context, input }) => {
        const board = await ensureBoard(deps.prisma, context.actor.spaceId);
        const row = await findTicket(deps.prisma, context.actor.spaceId, board, input);
        if (!row) {
          if (input.ref && !parseTicketRef(input.ref, board.ticketPrefix)) {
            throw new ORPCError("BAD_REQUEST", { message: "Invalid ticket reference." });
          }
          throw new IsolationError();
        }
        return toTicketDto(row, board.ticketPrefix);
      }),
      create: boardEnabled.tickets.create.handler(async ({ context, input }) => {
        await resolveSpaceBoard(deps.prisma, context.actor.spaceId, input.boardId);
        await repos.getBot(context.actor, input.assigneeBotId);
        const result = await createTicket(ticketDeps, {
          ...input,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          ownerBotId: input.assigneeBotId,
        });
        if ("error" in result) throw new ORPCError("BAD_REQUEST", { message: result.error });
        return result.ticket;
      }),
      update: boardEnabled.tickets.update.handler(async ({ context, input }) => {
        if (input.assigneeBotId) await repos.getBot(context.actor, input.assigneeBotId);
        const result = await updateTicket(ticketDeps, {
          ...input,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          ownerBotId: input.assigneeBotId,
        });
        if ("error" in result) throw new ORPCError("BAD_REQUEST", { message: result.error });
        return result.ticket;
      }),
      move: boardEnabled.tickets.move.handler(async ({ context, input }) => {
        const result = await updateTicket(ticketDeps, {
          ...input,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        });
        if ("error" in result) throw new ORPCError("BAD_REQUEST", { message: result.error });
        return result.ticket;
      }),
      comment: boardEnabled.tickets.comment.handler(async ({ context, input }) => {
        const result = await commentTicket(ticketDeps, {
          id: input.ticketId,
          body: input.body,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        });
        if ("error" in result) throw new ORPCError("BAD_REQUEST", { message: result.error });
        return result.comment;
      }),
      comments: boardEnabled.tickets.comments.handler(async ({ context, input }) => {
        const board = await ensureBoard(deps.prisma, context.actor.spaceId);
        const ticket = await deps.prisma.ticket.findFirst({
          where: { id: input.ticketId, spaceId: context.actor.spaceId, boardId: board.id },
        });
        if (!ticket) throw new IsolationError();
        const rows = await listTicketComments(deps.prisma, context.actor.spaceId, ticket.id);
        return rows.map(toTicketCommentDto);
      }),
    },
  };
}
