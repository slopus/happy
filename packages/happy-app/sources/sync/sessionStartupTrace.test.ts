import { describe, expect, it, vi } from 'vitest';

import {
    sanitizeSessionStartupTrace,
    serializeSessionStartupTrace,
    traceStartup,
} from './sessionStartupTrace';

describe('session startup trace serialization', () => {
    it('retains only the startup trace allowlist', () => {
        const serialized = serializeSessionStartupTrace({
            traceId: '00000000-0000-4000-8000-000000000001',
            stage: 'web.session.hydrated',
            timestamp: 1_725_000_000_000,
            duration: 321,
            outcome: 'error',
            sessionId: 'session-1',
            machineId: 'machine-1',
            errorCode: 'session-hydration-failed',
            token: 'token-canary',
            secret: 'secret-canary',
            apiKey: 'key-canary',
            ciphertext: 'ciphertext-canary',
            prompt: 'prompt-canary',
            message: 'message-canary',
            directory: '/private/directory-canary',
            dataEncryptionKey: 'encryption-key-canary',
            downloadUrl: 'https://download.invalid/canary',
            uploadUrl: 'https://upload.invalid/canary',
            authorization: 'Bearer authorization-canary',
            infrastructureAddress: 'https://relay.internal.invalid',
            error: 'raw-error-canary',
            stack: 'raw-stack-canary',
            arbitrary: 'arbitrary-canary',
        });

        expect(JSON.parse(serialized!)).toEqual({
            traceId: '00000000-0000-4000-8000-000000000001',
            stage: 'web.session.hydrated',
            timestamp: 1_725_000_000_000,
            duration: 321,
            outcome: 'error',
            sessionId: 'session-1',
            machineId: 'machine-1',
            errorCode: 'session-hydration-failed',
        });
        expect(serialized).not.toContain('canary');
    });

    it('logs only the serialized allowlisted object', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        try {
            traceStartup({
                traceId: '00000000-0000-4000-8000-000000000002',
                stage: 'web.spawn.clicked',
                timestamp: 1_725_000_000_100,
                outcome: 'success',
                token: 'token-canary',
            });

            expect(info).toHaveBeenCalledOnce();
            expect(info).toHaveBeenCalledWith(JSON.stringify({
                traceId: '00000000-0000-4000-8000-000000000002',
                stage: 'web.spawn.clicked',
                timestamp: 1_725_000_000_100,
                outcome: 'success',
            }));
        } finally {
            info.mockRestore();
        }
    });

    it.each([
        null,
        [],
        { traceId: 'not-a-uuid', stage: 'web.spawn.clicked' },
        { traceId: '00000000-0000-4000-8000-000000000001', stage: 'unknown-stage' },
        { traceId: '00000000-0000-4000-8000-000000000001', stage: 'web.spawn.clicked', outcome: 'maybe' },
        { traceId: '00000000-0000-4000-8000-000000000001', stage: 'web.spawn.clicked', timestamp: Number.NaN },
    ])('rejects malformed startup trace values without throwing (%j)', (event) => {
        expect(() => sanitizeSessionStartupTrace(event as any)).not.toThrow();
        expect(sanitizeSessionStartupTrace(event as any)).toBeNull();
        expect(serializeSessionStartupTrace(event as any)).toBeNull();
    });

    it('ignores nested and cyclic non-allowlisted data without throwing', () => {
        const event: Record<string, unknown> = {
            traceId: '00000000-0000-4000-8000-000000000001',
            stage: 'web.spawn.clicked',
            outcome: 'success',
            nested: { token: 'token-canary' },
        };
        event.cycle = event;

        expect(serializeSessionStartupTrace(event as any)).toBe(JSON.stringify({
            traceId: '00000000-0000-4000-8000-000000000001',
            stage: 'web.spawn.clicked',
            outcome: 'success',
        }));
    });

    it('snapshots each allowed property once so a stateful getter cannot bypass validation', () => {
        const secret: Record<string, unknown> = { token: 'getter-secret-canary' };
        secret.cycle = secret;
        let traceIdReads = 0;
        const event = {
            get traceId() {
                traceIdReads += 1;
                return traceIdReads === 1
                    ? '00000000-0000-4000-8000-000000000001'
                    : secret;
            },
            stage: 'web.spawn.clicked',
            nested: secret,
        };

        let serialized: string | null | undefined;
        expect(() => { serialized = serializeSessionStartupTrace(event); }).not.toThrow();
        expect(traceIdReads).toBe(1);
        expect(serialized).toBe(JSON.stringify({
            traceId: '00000000-0000-4000-8000-000000000001',
            stage: 'web.spawn.clicked',
        }));
        expect(serialized).not.toContain('canary');
    });

    it('never lets serialization or console failures escape into startup logic', () => {
        const throwingEvent = Object.defineProperty({}, 'traceId', {
            get: () => { throw new Error('getter-canary'); },
        });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {
            throw new Error('logger-canary');
        });
        try {
            expect(() => traceStartup(throwingEvent as any)).not.toThrow();
            expect(() => traceStartup({
                traceId: '00000000-0000-4000-8000-000000000001',
                stage: 'web.spawn.clicked',
            })).not.toThrow();
        } finally {
            info.mockRestore();
        }
    });
});
