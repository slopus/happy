import { describe, expect, it } from 'vitest';
import { parsePublicSessionShareJobs } from './publicSessionShareQueuePersistence';

describe('parsePublicSessionShareJobs', () => {
    it('restores valid queued and interrupted jobs', () => {
        const raw = JSON.stringify([
            {
                id: 'job-1', sessionId: 'session-1', title: 'Release notes', requestedAt: 100,
                cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, status: 'running', progress: { completed: 1, total: 2 },
                notificationPending: false, updatedAt: 110,
            },
        ]);

        expect(parsePublicSessionShareJobs(raw)).toEqual([
            {
                id: 'job-1', sessionId: 'session-1', title: 'Release notes', requestedAt: 100,
                cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, status: 'running', progress: { completed: 1, total: 2 },
                notificationPending: false, updatedAt: 110,
            },
        ]);
    });

    it('drops malformed or unsupported persisted records', () => {
        expect(parsePublicSessionShareJobs('{not-json')).toEqual([]);
        expect(parsePublicSessionShareJobs(JSON.stringify([
            { id: 'missing-fields', status: 'queued' },
            {
                id: 'job-2', sessionId: 'session-2', title: 'Title', requestedAt: 100,
                groupToolCalls: true, status: 'unknown', progress: { completed: 0, total: 0 }, updatedAt: 100,
            },
        ]))).toEqual([]);
    });
});
