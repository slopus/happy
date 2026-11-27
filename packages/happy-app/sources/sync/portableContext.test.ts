import { describe, expect, it } from 'vitest';
import type { PortableContextSnapshot } from '@slopus/happy-wire';
import type { DecryptedMessage } from './storageTypes';
import { assertPortableContextSourceScope, buildPortableContextPreview, portableItemsFromRows } from './portableContext';

const row = (seq: number, content: any): DecryptedMessage => ({ id: `wire-${seq}`, localId: null, createdAt: seq, seq, content });
const acp = (type: string, data: object) => ({ role: 'agent', content: { type: 'acp', provider: 'opencode', data: { type, ...data } } });
const snapshot = (items: PortableContextSnapshot['items']): PortableContextSnapshot => ({ version: 1,
    id: '9efc1c63-e694-44c6-b14e-3b1e6fae0706', rootSessionId: 'root', sourceSessionId: 'root',
    heads: [{ sessionId: 'root', throughSeq: 100, afterSeq: 0 }], items });

describe('portable source history', () => {
    it('preserves failed and interrupted root turns and explicit runtime failure notices as history', () => {
        const protocol = (status: string, extra: object = {}) => ({ role: 'session', content: { type: 'session', data: {
            id: 'end', time: 1, role: 'agent', turn: 'root-turn', ...extra, ev: { t: 'turn-end', status },
        } } });
        const items = portableItemsFromRows('root', [row(1, protocol('failed')), row(2, protocol('cancelled')),
            row(3, { role: 'agent', content: { type: 'event', id: 'failure', data: { type: 'message', message: 'Process exited unexpectedly' } } }),
            row(4, { role: 'agent', content: { type: 'event', id: 'interrupt', data: { type: 'message', message: 'Aborted by user' } } }),
            row(5, acp('turn_aborted', { id: 'legacy-interrupt' })),
        ]);
        expect(items).toHaveLength(5);
        expect(items.every(item => item.role === 'event')).toBe(true);
        expect(items[0].text).toContain('status failed');
        expect(items[1].text).toContain('status cancelled');
        expect(items[2].text).toContain('Process exited unexpectedly');
        expect(items[3].text).toContain('Aborted by user');
        expect(items[4].text).toContain('interrupted');
    });

    it('ignores ordinary ready, successful completion, usage and child terminal signals', () => {
        const protocol = (status: string, extra: object = {}) => ({ role: 'session', content: { type: 'session', data: {
            id: 'end', time: 1, role: 'agent', turn: 'turn', ...extra, ev: { t: 'turn-end', status },
        } } });
        const items = portableItemsFromRows('root', [row(1, protocol('completed')),
            row(2, protocol('failed', { subagent: 'a'.repeat(24) })),
            row(3, { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready' } } }),
            row(4, { role: 'agent', content: { type: 'event', id: 'notice', data: { type: 'message', message: 'Compaction completed' } } }),
            row(5, acp('token_count', { total: 42 })),
        ]);
        expect(items).toEqual([]);
    });
    it('preserves large user and tool output verbatim, including late offsets beyond the old handoff cap', () => {
        const user = 'starting goal\n' + '中'.repeat(30000) + '\nEARLY_TAIL';
        const output = 'command evidence\n' + 'x'.repeat(90000) + '\nEXIT=17 LATE_RESULT';
        const items = portableItemsFromRows('root', [
            row(1, { role: 'user', content: { type: 'text', text: user } }),
            row(2, acp('tool-call', { id: 'c', callId: 'c', name: 'Bash', input: { cmd: 'fixture-command' } })),
            row(3, acp('tool-result', { id: 'r', callId: 'c', output, isError: true })),
        ]);
        expect(items[0].text).toBe(user);
        expect(items[1].text).toContain('fixture-command');
        expect(items[2].text).toContain(output);
        expect(items[2].text).toContain('failed');
        const preview = buildPortableContextPreview(snapshot(items));
        expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(64000);
        expect(preview).toContain('omitted from this import: 2');
        expect(preview).not.toContain('EARLY_TAIL');
        expect(preview).toContain('thread_read');
        expect(items[0].text).toContain('EARLY_TAIL');
    });

    it('keeps command result, exit code, plan and file change as historical data', () => {
        const items = portableItemsFromRows('root', [
            row(1, acp('tool-call', { id: 'p', callId: 'p', name: 'update_plan', input: { plan: ['fix parser'] } })),
            row(2, acp('tool-result', { id: 'r', callId: 'c', output: { stdout: 'already done', exitCode: 7 }, isError: true })),
            row(3, acp('file-edit', { id: 'e', filePath: '/work/parser.ts', description: 'fixed empty rows', diff: '+filter(Boolean)' })),
        ]);
        expect(items.map(item => item.text).join('\n')).toContain('exitCode');
        expect(items.map(item => item.text).join('\n')).toContain('/work/parser.ts');
        expect(items.map(item => item.text).join('\n')).toContain('update_plan');
        expect(items.every(item => item.role === 'tool')).toBe(true);
    });

    it('retains original file references but no local arbitrary path or decryption key in model text', () => {
        const items = portableItemsFromRows('root', [row(1, { role: 'session', content: { type: 'session', data: {
            id: 'image-message', time: 1, role: 'user', ev: { t: 'file', ref: 'opaque-ref', name: 'diagram.png', size: 32,
                image: { width: 10, height: 20 }, localPath: '/private/old-path.png' },
        } } })]);
        expect(items[0].attachments).toEqual([{ id: 'root/1/0/attachment', sourceSessionId: 'root', ref: 'opaque-ref',
            name: 'diagram.png', size: 32, kind: 'image', encrypted: true }]);
        expect(items[0].text).toContain('thread_attachment');
        expect(JSON.stringify(items)).not.toContain('/private/old-path');
    });

    it('excludes private reasoning, approval state and recursive earlier injected prompts', () => {
        const items = portableItemsFromRows('root', [
            row(1, { role: 'user', content: { type: 'text', text: 'old context and injected secrets' },
                meta: { displayText: 'Actual user question', continuationContextSourceId: 'older' } }),
            row(2, acp('thinking', { text: 'PRIVATE_REASONING' })),
            row(4, acp('reasoning', { message: 'PRIVATE_ACP_REASONING' })),
            row(5, { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'PRIVATE_CODEX_REASONING' } } }),
            row(3, acp('permission-request', { permissionId: 'p', toolName: 'Bash', description: 'approval', options: ['allow'] })),
        ]);
        expect(items.map(item => item.text)).toEqual(['Actual user question']);
    });

    it('fails explicitly on undecryptable or unrecognized source records', () => {
        expect(() => portableItemsFromRows('root', [row(1, null)])).toThrow('decryption');
        expect(() => portableItemsFromRows('root', [row(1, { role: 'unknown', content: 'cannot interpret' })])).toThrow('unsupported-record');
    });

    it('only excludes proven native coverage with the same clear boundary', () => {
        const items = portableItemsFromRows('root', [row(1, { role: 'user', content: { type: 'text', text: 'OLD_NATIVE_FACT' } }),
            row(2, { role: 'user', content: { type: 'text', text: 'NEW_FACT' } })]);
        const preview = buildPortableContextPreview(snapshot(items), [{ sessionId: 'root', throughSeq: 1, afterSeq: 0 }]);
        expect(preview).not.toContain('OLD_NATIVE_FACT');
        expect(preview).toContain('NEW_FACT');
        expect(buildPortableContextPreview(snapshot(items), [{ sessionId: 'root', throughSeq: 100, afterSeq: 9 }])).toContain('OLD_NATIVE_FACT');
    });

    it('keeps complete chosen Unicode items while skipping oversized entries', () => {
        const items = portableItemsFromRows('root', [row(1, { role: 'user', content: { type: 'text', text: 'first request' } }),
            row(2, { role: 'user', content: { type: 'text', text: '大'.repeat(40000) } }),
            row(3, { role: 'user', content: { type: 'text', text: 'latest request' } })]);
        const preview = buildPortableContextPreview(snapshot(items), [], 2200);
        expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(2200);
        expect(preview).toContain('latest request');
        expect(preview).toContain('first request');
        expect(preview).not.toContain('大');
    });
});

describe('portable fork source admission', () => {
    it('rejects an explicit legacy rewind point without proof of a new context boundary', () => {
        expect(() => assertPortableContextSourceScope({ forkedFromMessageId: 'selected-message' }))
            .toThrow('portable-context-fork-boundary-unverified');
    });
    it('admits a reset fork and ordinary children without a rewind point', () => {
        expect(() => assertPortableContextSourceScope({ forkedFromMessageId: 'selected-message',
            portableContextBoundary: { id: '9efc1c63-e694-44c6-b14e-3b1e6fae0706', afterSeq: 9 } })).not.toThrow();
        const child = { parentSessionId: 'independent-parent' };
        expect(() => assertPortableContextSourceScope(child)).not.toThrow();
        expect(() => assertPortableContextSourceScope(null)).not.toThrow();
    });
});

it('excludes named synthetic reasoning calls and their bodies rather than mistaking them for native tools', () => {
    const items = portableItemsFromRows('root', [
        row(1, acp('tool-call', { id: 'p', callId: 'private', name: 'CodexReasoning', input: { title: 'PRIVATE_TITLE' } })),
        row(2, acp('tool-result', { id: 'r', callId: 'private', output: 'PRIVATE_BODY' })),
    ]);
    expect(items).toEqual([]);
});
