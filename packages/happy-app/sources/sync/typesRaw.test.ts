import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './typesRaw';

describe('normalizeRawMessage session envelopes', () => {
    it('preserves enriched tool-call-end results from the session protocol', () => {
        const raw = {
            role: 'session',
            content: {
                id: 'ev-1',
                time: 456,
                role: 'agent',
                turn: 'turn-1',
                ev: {
                    t: 'tool-call-end',
                    call: 'call-1',
                    result: {
                        content: 'stdout text',
                        status: 'error',
                        exitCode: 2,
                        durationMs: 50,
                        cwd: '/tmp/project',
                        command: 'false',
                    },
                },
            },
        } as never;

        const normalized = normalizeRawMessage('raw-1', null, 123, raw);

        expect(normalized?.content).toEqual([expect.objectContaining({
            type: 'tool-result',
            tool_use_id: 'call-1',
            content: 'stdout text',
            is_error: true,
            result: {
                content: 'stdout text',
                status: 'error',
                exitCode: 2,
                durationMs: 50,
                cwd: '/tmp/project',
                command: 'false',
            },
        })]);
    });
});
