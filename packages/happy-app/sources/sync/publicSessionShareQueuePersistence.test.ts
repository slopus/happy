import { describe, expect, it } from 'vitest';
import { parsePublicSessionShareJobs } from './publicSessionShareQueuePersistence';

describe('parsePublicSessionShareJobs', () => {
    it('restores valid queued and interrupted jobs', () => {
        const raw = JSON.stringify([
            {
                id: 'job-1', sessionId: 'session-1', title: 'Release notes', requestedAt: 100,
                cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, themePack: 'caramel', status: 'running', progress: { completed: 1, total: 2 },
                notificationPending: false, updatedAt: 110,
            },
        ]);

        expect(parsePublicSessionShareJobs(raw)).toEqual([
            {
                id: 'job-1', sessionId: 'session-1', title: 'Release notes', requestedAt: 100,
                cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, themePack: 'caramel', status: 'running', progress: { completed: 1, total: 2 },
                notificationPending: false, updatedAt: 110,
            },
        ]);
    });

    it('round-trips theme and discriminated cover selections through persisted JSON', () => {
        const jobs = [
            {
                id: 'job-existing', sessionId: 'session-existing', title: 'Existing', requestedAt: 50,
                cutoffSeq: 21, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, themePack: 'sage',
                coverSelection: { kind: 'existing', assetId: '51515151-5151-4515-8515-515151515151' },
                status: 'queued', progress: { completed: 0, total: 1 }, notificationPending: false, updatedAt: 60,
            },
            {
                id: 'job-pexels', sessionId: 'session-pexels', title: 'Pexels', requestedAt: 100,
                cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: true, themePack: 'sakura', coverSelection: { kind: 'pexels', photoId: 123 },
                status: 'queued', progress: { completed: 0, total: 1 }, notificationPending: false, updatedAt: 110,
            },
            {
                id: 'job-upload', sessionId: 'session-upload', title: 'Upload', requestedAt: 200,
                cutoffSeq: 84, ownerId: 'owner-1', serverUrl: 'https://paws.test',
                groupToolCalls: false, themePack: 'terminal',
                coverSelection: {
                    kind: 'upload',
                    attachmentId: '11111111-1111-4111-8111-111111111111',
                    uri: 'file:///tmp/cover.webp',
                    name: 'cover.webp',
                    mimeType: 'image/webp',
                    size: 321,
                    width: 1600,
                    height: 600,
                    thumbhash: 'safe-thumbhash',
                },
                status: 'running', progress: { completed: 0, total: 1 }, notificationPending: false, updatedAt: 210,
            },
        ];

        expect(parsePublicSessionShareJobs(JSON.stringify(jobs))).toEqual(jobs);
    });

    it.each([
        'file:///tmp/cover.webp',
        'content://media/external/images/123',
        'blob:https://paws.test/11111111-1111-4111-8111-111111111111',
    ])('round-trips the supported local upload URI %s', (uri) => {
        const job = {
            id: 'job-upload', sessionId: 'session-upload', title: 'Upload', requestedAt: 100,
            cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
            groupToolCalls: true, themePack: 'sage', status: 'queued', progress: { completed: 0, total: 1 },
            notificationPending: false, updatedAt: 110,
            coverSelection: {
                kind: 'upload',
                attachmentId: '11111111-1111-4111-8111-111111111111',
                uri,
                name: 'cover.webp',
                mimeType: 'image/webp',
                size: 321,
                width: 1600,
                height: 600,
            },
        };

        expect(parsePublicSessionShareJobs(JSON.stringify([job]))).toEqual([job]);
    });

    it('defaults historical appearance fields independently to caramel and no cover', () => {
        const historical = {
            id: 'job-old', sessionId: 'session-old', title: 'Historical', requestedAt: 100,
            cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
            groupToolCalls: true, status: 'queued', progress: { completed: 0, total: 0 },
            notificationPending: false, updatedAt: 110,
        };

        expect(parsePublicSessionShareJobs(JSON.stringify([historical]))).toEqual([{
            ...historical,
            themePack: 'caramel',
        }]);
    });

    it('drops only a malformed cover selection without discarding its job or valid siblings', () => {
        const base = {
            title: 'Title', requestedAt: 100, cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
            groupToolCalls: true, themePack: 'gingham', status: 'queued', progress: { completed: 0, total: 1 },
            notificationPending: false, updatedAt: 110,
        };
        const malformed = {
            ...base,
            id: 'job-malformed', sessionId: 'session-malformed',
            coverSelection: { kind: 'pexels', photoId: -1, previewUrl: 'https://attacker.invalid/image.jpg' },
        };
        const valid = {
            ...base,
            id: 'job-valid', sessionId: 'session-valid',
            coverSelection: { kind: 'pexels', photoId: 456 },
        };

        expect(parsePublicSessionShareJobs(JSON.stringify([malformed, valid]))).toEqual([
            { ...malformed, coverSelection: undefined },
            valid,
        ]);
    });

    it('drops upload metadata that could persist bytes or fetch a remote resource', () => {
        const job = {
            id: 'job-upload', sessionId: 'session-upload', title: 'Upload', requestedAt: 100,
            cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
            groupToolCalls: true, themePack: 'sage', status: 'queued', progress: { completed: 0, total: 1 },
            notificationPending: false, updatedAt: 110,
            coverSelection: {
                kind: 'upload',
                attachmentId: '11111111-1111-4111-8111-111111111111',
                uri: 'https://attacker.invalid/cover.svg',
                name: 'cover.svg',
                mimeType: 'image/svg+xml',
                size: 321,
                width: 1600,
                height: 600,
            },
        };

        expect(parsePublicSessionShareJobs(JSON.stringify([job]))).toEqual([{
            ...job,
            coverSelection: undefined,
        }]);
    });

    it.each([
        ['image/avif', true],
        ['image/gif', false],
    ] as const)('treats %s as a safe persisted cover MIME: %s', (mimeType, accepted) => {
        const job = {
            id: 'job-upload', sessionId: 'session-upload', title: 'Upload', requestedAt: 100,
            cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
            groupToolCalls: true, themePack: 'sage', status: 'queued', progress: { completed: 0, total: 1 },
            notificationPending: false, updatedAt: 110,
            coverSelection: {
                kind: 'upload',
                attachmentId: '11111111-1111-4111-8111-111111111111',
                uri: 'file:///tmp/cover',
                name: 'cover',
                mimeType,
                size: 321,
                width: 1600,
                height: 600,
            },
        };

        expect(parsePublicSessionShareJobs(JSON.stringify([job]))[0]?.coverSelection)
            .toEqual(accepted ? job.coverSelection : undefined);
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
