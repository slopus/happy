import type { Socket } from 'socket.io';
import { z } from 'zod';

import { streamRelationshipAdvisor } from '@/modules/relationship-advisor/relationshipAdvisorClient';
import {
    deleteRelationshipAdvisorImages,
    resolveRelationshipAdvisorImageUrls,
} from '@/modules/relationship-advisor/relationshipAdvisorImages';

export interface RelationshipAdvisorMessage {
    role: 'user' | 'assistant';
    text: string;
}

export interface RelationshipAdvisorStartRequest {
    requestId: string;
    messages: RelationshipAdvisorMessage[];
    imageRefs: string[];
}

export interface RelationshipAdvisorStreamInput extends RelationshipAdvisorStartRequest {
    userId: string;
    imageUrls: string[];
}

export interface RelationshipAdvisorHandlerDependencies {
    streamChat: (input: RelationshipAdvisorStreamInput & { signal?: AbortSignal }) => AsyncIterable<{ text: string }>;
    resolveImageUrls: (userId: string, refs: string[]) => Promise<string[]>;
    deleteImageRefs?: (userId: string, refs: string[]) => Promise<void>;
}

type AdvisorSocket = Pick<Socket, 'on' | 'emit'>;

function defaultRelationshipAdvisorDependencies(): RelationshipAdvisorHandlerDependencies {
    return {
        streamChat: (input) => {
            const apiKey = process.env.HAPPY_RELATIONSHIP_ADVISOR_API_KEY?.trim();
            const baseUrl = process.env.HAPPY_RELATIONSHIP_ADVISOR_BASE_URL?.trim();
            const model = process.env.HAPPY_RELATIONSHIP_ADVISOR_MODEL?.trim();
            if (!apiKey || !baseUrl || !model) {
                throw new Error('Relationship advisor provider is not configured');
            }
            return streamRelationshipAdvisor({
                messages: input.messages,
                imageUrls: input.imageUrls,
                signal: input.signal,
            }, { apiKey, baseUrl, model });
        },
        resolveImageUrls: resolveRelationshipAdvisorImageUrls,
        deleteImageRefs: deleteRelationshipAdvisorImages,
    };
}

const relationshipAdvisorStartRequestSchema = z.object({
    requestId: z.string().min(1).max(100),
    messages: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(8_000),
    })).min(1).max(12),
    imageRefs: z.array(z.string().regex(
        /^advisor\/[A-Za-z0-9_-]{1,128}\/[a-f0-9-]{20,64}\.(?:jpe?g|png|webp)$/,
    )).max(4),
}).refine((request) => {
    const latest = request.messages.at(-1);
    return latest?.role === 'user' && (latest.text.trim().length > 0 || request.imageRefs.length > 0);
});

const requestRateState = new Map<string, { startedAt: number; count: number }>();

function canStartRelationshipAdvisorRequest(userId: string): boolean {
    const now = Date.now();
    const state = requestRateState.get(userId);
    if (!state || now - state.startedAt >= 60_000) {
        requestRateState.set(userId, { startedAt: now, count: 1 });
        return true;
    }
    if (state.count >= 30) return false;
    state.count++;
    return true;
}

export function relationshipAdvisorHandler(
    userId: string,
    socket: AdvisorSocket,
    dependencies: RelationshipAdvisorHandlerDependencies = defaultRelationshipAdvisorDependencies(),
) {
    const activeRequests = new Map<string, AbortController>();

    socket.on('relationship-advisor:start', (
        input: RelationshipAdvisorStartRequest,
        acknowledge?: (response: { ok: true } | { ok: false; error: string }) => void,
    ) => {
        const parsed = relationshipAdvisorStartRequestSchema.safeParse(input);
        if (!parsed.success) {
            acknowledge?.({ ok: false, error: 'Invalid request' });
            return;
        }
        if (activeRequests.size > 0) {
            acknowledge?.({ ok: false, error: 'Request already active' });
            return;
        }
        if (!canStartRelationshipAdvisorRequest(userId)) {
            acknowledge?.({ ok: false, error: 'Too many requests' });
            return;
        }
        const request = parsed.data;
        const abortController = new AbortController();
        let timedOut = false;
        const firstTokenTimeout = setTimeout(() => {
            timedOut = true;
            abortController.abort();
        }, 15_000);
        const totalTimeout = setTimeout(() => {
            timedOut = true;
            abortController.abort();
        }, 120_000);
        activeRequests.set(request.requestId, abortController);
        acknowledge?.({ ok: true });
        socket.emit('relationship-advisor:event', {
            requestId: request.requestId,
            type: 'accepted',
        });

        void (async () => {
            try {
                const imageUrls = await dependencies.resolveImageUrls(userId, request.imageRefs);
                for await (const delta of dependencies.streamChat({
                    ...request,
                    userId,
                    imageUrls,
                    signal: abortController.signal,
                })) {
                    if (delta.text) {
                        clearTimeout(firstTokenTimeout);
                        socket.emit('relationship-advisor:event', {
                            requestId: request.requestId,
                            type: 'delta',
                            text: delta.text,
                        });
                    }
                }
                socket.emit('relationship-advisor:event', timedOut
                    ? {
                        requestId: request.requestId,
                        type: 'error',
                        error: 'Relationship advisor is temporarily unavailable',
                    }
                    : {
                        requestId: request.requestId,
                        type: 'done',
                    });
            } catch {
                socket.emit('relationship-advisor:event', abortController.signal.aborted && !timedOut
                    ? {
                        requestId: request.requestId,
                        type: 'done',
                    }
                    : {
                        requestId: request.requestId,
                        type: 'error',
                        error: 'Relationship advisor is temporarily unavailable',
                    });
            } finally {
                clearTimeout(firstTokenTimeout);
                clearTimeout(totalTimeout);
                activeRequests.delete(request.requestId);
                void dependencies.deleteImageRefs?.(userId, request.imageRefs).catch(() => undefined);
            }
        })();
    });

    socket.on('relationship-advisor:cancel', (request: { requestId: string }) => {
        activeRequests.get(request.requestId)?.abort();
    });

    socket.on('disconnect', () => {
        for (const request of activeRequests.values()) request.abort();
        activeRequests.clear();
    });
}
