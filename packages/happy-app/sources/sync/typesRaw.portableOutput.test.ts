import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, type RawRecord } from './typesRaw';

const normalize = (fields: object) => normalizeRawMessage('wire', null, 1, {
    role: 'session', content: { type: 'session', data: { id: 'end', time: 1, role: 'agent', turn: 'turn',
        ev: { t: 'tool-call-end', call: 'command', status: 'failed', ...fields },
    } },
} as RawRecord);

describe('durable tool output normalization', () => {
    it('preserves complete output and the exit code independently of an abbreviated failure', () => {
        const output = { stdout: `${'x'.repeat(90000)}\nFINAL_RESULT`, stderr: 'compile failed' };
        const message = normalize({ output, exitCode: 17, error: { summary: 'Compile failed', detail: 'short failure' } });
        expect(message?.role === 'agent' && message.content[0]).toMatchObject({
            type: 'tool-result', content: output, exitCode: 17, is_error: true,
        });
    });

    it('preserves an explicitly empty result and keeps legacy error text when output is absent', () => {
        const empty = normalize({ output: null, error: { summary: 'Failure with no output' } });
        expect(empty?.role === 'agent' && empty.content[0]).toMatchObject({ type: 'tool-result', content: null });
        const legacy = normalize({ error: { summary: 'Legacy failure' } });
        expect(legacy?.role === 'agent' && legacy.content[0]).toMatchObject({ type: 'tool-result', content: 'Legacy failure' });
    });
});
