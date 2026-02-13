import { createId } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
    t: z.literal('text'),
    text: z.string(),
    thinking: z.boolean().optional(),
});

export const sessionToolCallStartEventSchema = z.object({
    t: z.literal('tool-call-start'),
    call: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string(),
    args: z.record(z.string(), z.unknown()),
});

export const sessionToolCallEndEventSchema = z.object({
    t: z.literal('tool-call-end'),
    call: z.string(),
});

export const sessionFileEventSchema = z.object({
    t: z.literal('file'),
    ref: z.string(),
    name: z.string(),
});

export const sessionPhotoEventSchema = z.object({
    t: z.literal('photo'),
    ref: z.string(),
    thumbhash: z.string(),
    width: z.number(),
    height: z.number(),
});

export const sessionTurnStartEventSchema = z.object({
    t: z.literal('turn-start'),
});

export const sessionTurnEndEventSchema = z.object({
    t: z.literal('turn-end'),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
    sessionTextEventSchema,
    sessionToolCallStartEventSchema,
    sessionToolCallEndEventSchema,
    sessionFileEventSchema,
    sessionPhotoEventSchema,
    sessionTurnStartEventSchema,
    sessionTurnEndEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z.object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    invoke: z.string().optional(),
    ev: sessionEventSchema,
});

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
    id?: string;
    time?: number;
    turn?: string;
    invoke?: string;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
    return {
        id: opts.id ?? createId(),
        time: opts.time ?? Date.now(),
        role,
        ...(opts.turn ? { turn: opts.turn } : {}),
        ...(opts.invoke ? { invoke: opts.invoke } : {}),
        ev,
    };
}
