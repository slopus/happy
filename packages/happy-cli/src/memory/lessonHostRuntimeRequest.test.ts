import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { requestLessonSnapshotGrant } from './lessonHostRuntime';

describe('session-bound lesson snapshot request', () => {
    it('sends verified caller context and actual session to the machine route', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ envelope: 'signed' })));
        const result = await requestLessonSnapshotGrant({
            studioBaseUrl: 'https://studio.example', token: 'machine-token', machineId: 'm1', projectId: 'p1',
            sessionAuthority: { sessionId: 's1', callerGrant: 'verified-caller' }, fetchImpl,
        });
        expect(result).toBe('signed');
        expect(fetchImpl).toHaveBeenCalledOnce();
        const [url, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://studio.example/api/projects/p1/lesson-host/snapshot');
        expect(JSON.parse(options.body as string)).toEqual({
            machineId: 'm1', sessionId: 's1', callerGrant: 'verified-caller',
            request: { version: 1, projectId: 'p1', requestId: 'open:p1', operation: 'snapshot' },
        });
    });

    it('never downgrades a rejected machine request to user authority', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 }));
        expect(await requestLessonSnapshotGrant({
            studioBaseUrl: 'https://studio.example', token: 'machine-token', machineId: 'm1', projectId: 'p1',
            sessionAuthority: { sessionId: 's1', callerGrant: 'expired' }, fetchImpl,
        })).toBeNull();
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('logs the refusal status without any credential', async () => {
        const debug = vi.spyOn(logger, 'debug');
        try {
            const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_caller_grant"}', { status: 403 }));
            expect(await requestLessonSnapshotGrant({
                studioBaseUrl: 'https://studio.example', token: 'machine-token', machineId: 'm1', projectId: 'p1',
                sessionAuthority: { sessionId: 's1', callerGrant: 'caller-grant-value' }, fetchImpl,
            })).toBeNull();
            const lines = debug.mock.calls.map(([line]) => String(line));
            expect(lines).toContain('[lesson-host] snapshot grant refused 403 (session)');
            expect(lines.join('\n')).not.toMatch(/machine-token|caller-grant-value/);
        } finally {
            debug.mockRestore();
        }
    });
});
