import { persistSessionEvent } from "@/app/events/persistSessionEvent";
import { checkpointEventEnvelopeSchema } from "@/app/events/checkpointEventEnvelope";
import { persistCheckpointSessionEvent } from "@/app/events/persistCheckpointSessionEvent";
import { SESSION_EVENT_TYPES, type SessionEventType } from "@/app/events/sessionEventTypes";
import { db } from "@/storage/db";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { type Fastify } from "../types";
import { requireSessionScopeAuth } from "@/app/api/utils/enableAuthentication";

const validEventTypes = Object.values(SESSION_EVENT_TYPES) as [string, ...string[]];

const checkpointEventTypes = new Set<string>([
    SESSION_EVENT_TYPES.CHECKPOINT_SNAPSHOT,
    SESSION_EVENT_TYPES.CHECKPOINT_REWIND,
]);
const checkpointEventTypeValues = [...checkpointEventTypes] as [string, ...string[]];
const legacyEventTypeValues = validEventTypes.filter(
    (eventType) => !checkpointEventTypes.has(eventType),
) as [string, ...string[]];

export const sendEventBodySchema = z.union([
    z.object({
        eventType: z.enum(checkpointEventTypeValues),
        content: z.string(),
        checkpoint: checkpointEventEnvelopeSchema,
    }).strict(),
    // COMPAT(web-checkpoint-history): added 2026-09; remove only after web
    // history producers and stored legacy events have migrated to a distinct type.
    // Missing metadata is legacy history, never a protected checkpoint receipt.
    z.object({
        eventType: z.enum(checkpointEventTypeValues),
        content: z.string(),
        checkpoint: z.never().optional(),
    }).strict(),
    z.object({
        eventType: z.enum(legacyEventTypeValues),
        content: z.string(),
        checkpoint: z.never().optional(),
    }),
]);

export const getEventsQuerySchema = z
    .object({
        after_seq: z.coerce.number().int().min(0).default(0),
        before_seq: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        type: z.string().optional(),
        order: z.enum(['asc', 'desc']).default('asc'),
        // COMPAT(web-checkpoint-history): released Desktop builds reject a whole
        // checkpoint timeline on one envelope-less row, so only readers that
        // understand legacy web history receive it.
        include_legacy: z.literal('1').optional(),
    })
    .refine(
        // `after_seq` defaults to 0, so treat "explicitly > 0 AND before_seq set" as the ambiguous case.
        // Sending both cursors at once leaves the filter direction undefined; callers must pick one.
        (q) => !(q.after_seq > 0 && q.before_seq !== undefined),
        { message: 'after_seq and before_seq cannot be combined' },
    );

interface SelectedEvent {
    id: string;
    eventType: string;
    seq: number;
    content: unknown;
    checkpoint: unknown;
    createdAt: Date;
    updatedAt: Date;
}

function toResponseEvent(event: SelectedEvent) {
    const checkpoint = event.checkpoint === null
        ? null
        : checkpointEventEnvelopeSchema.parse(event.checkpoint);
    return {
        id: event.id,
        eventType: event.eventType,
        seq: event.seq,
        content: event.content,
        ...(checkpoint ? { checkpoint } : {}),
        createdAt: event.createdAt.getTime(),
        updatedAt: event.updatedAt.getTime(),
    };
}

export function v3SessionEventRoutes(app: Fastify) {
    // GET only. The POST below writes session events, which no managed
    // consumer needs, so sharing a path does not carry it in.
    app.get('/v3/sessions/:sessionId/events', {
        preHandler: requireSessionScopeAuth(app) as never,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            querystring: getEventsQuerySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit, type, order, include_legacy } = request.query;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true },
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const where: {
            sessionId: string;
            seq: { gt: number } | { lt: number };
            eventType?: string;
            checkpoint?: { not: typeof Prisma.DbNull };
        } = {
            sessionId,
            seq: before_seq !== undefined ? { lt: before_seq } : { gt: after_seq },
        };
        if (type) {
            where.eventType = type;
            if (checkpointEventTypes.has(type) && !include_legacy) {
                where.checkpoint = { not: Prisma.DbNull };
            }
        }

        const events = await db.sessionEvent.findMany({
            where,
            orderBy: { seq: order },
            take: limit + 1,
            select: {
                id: true,
                eventType: true,
                seq: true,
                content: true,
                checkpoint: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        const hasMore = events.length > limit;
        const page = hasMore ? events.slice(0, limit) : events;

        return reply.send({
            events: page.map(toResponseEvent),
            hasMore,
        });
    });

    app.post('/v3/sessions/:sessionId/events', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: sendEventBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { eventType, content, checkpoint } = request.body;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true },
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const checkpointEvent = checkpoint
            ? await persistCheckpointSessionEvent({
                sessionId,
                eventType: eventType as SessionEventType,
                content,
                checkpoint,
            })
            : null;
        const event = checkpointEvent ?? await persistSessionEvent({
            sessionId,
            eventType: eventType as SessionEventType,
            content,
        });

        return reply.send({
            event: {
                id: event.id,
                seq: event.seq,
                createdAt: event.createdAt.getTime(),
                ...(checkpointEvent ? { idempotent: checkpointEvent.idempotent } : {}),
            },
        });
    });
}
