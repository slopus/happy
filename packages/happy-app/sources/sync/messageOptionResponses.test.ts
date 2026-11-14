import { describe, expect, it, vi } from 'vitest';
import { inferMessageOptionResponses, messageOptionKey, withMessageOptionResponse } from './messageOptionResponses';
import { updateEncryptedSessionMetadata } from './sessionMetadata';
import type { Message } from './typesMessage';
import type { Metadata } from './storageTypes';
const mocks = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: mocks.emit } }));
const question = (id: string, createdAt: number) => ({ id, createdAt, kind: 'agent-text', text: 'Choose\n<options><option>A</option></options>' }) as Message;
const answer = (id: string, createdAt: number, text: string) => ({ id, createdAt, kind: 'user-text', text }) as Message;
const receipt = { status: 'answered' as const, answer: 'A', updatedAt: 10 };
describe('message option response history', () => {
    it('infers composer replies from either history order and leaves the unanswered question active', () => {
        const messages = [question('latest', 9), answer('reply2', 8, 'custom reply'), question('q2', 7), answer('reply1', 5, 'A'), question('q1', 3)];
        for (const input of [messages, [...messages].reverse()]) {
            const responses = inferMessageOptionResponses(input);
            expect(responses.get('q1')).toMatchObject({ status: 'answered', answer: 'A' });
            expect(responses.get('q2')).toMatchObject({ status: 'answered', answer: 'custom reply' });
            expect(responses.has('latest')).toBe(false);
        }
    });
    it('uses stable wire/block identity when reducer IDs and streaming text change', () => {
        const first = { text: 'partial', createdAt: 1 };
        const replay = { text: 'final', createdAt: 2 };
        expect(messageOptionKey(first, 'wire', 'text:0')).toBe(messageOptionKey(replay, 'wire', 'text:0'));
        expect(messageOptionKey(first, 'wire', 'text:1')).not.toBe(messageOptionKey(first, 'wire', 'text:0'));
        expect(messageOptionKey(first)).toBe(messageOptionKey({ ...first }));
        expect(messageOptionKey(first)).not.toBe(messageOptionKey({ ...first, text: 'other' }));
    });
    it('preserves the first recorded decision and unrelated metadata through a CAS conflict', async () => {
        mocks.emit.mockReset();
        const initial = { path: '/fixture', host: 'synthetic' } as Metadata;
        const concurrent = { ...initial, name: 'new title', messageOptionResponses: { other: receipt } };
        mocks.emit.mockResolvedValueOnce({ result: 'version-mismatch', version: 2, metadata: JSON.stringify(concurrent) });
        mocks.emit.mockImplementationOnce(async (_event, payload) => ({ result: 'success', version: 3, metadata: payload.metadata }));
        const crypto = { encryptRaw: async (v: unknown) => JSON.stringify(v), decryptRaw: async (v: string) => JSON.parse(v) } as any;
        const result = await updateEncryptedSessionMetadata('s', initial, 1, crypto, value => withMessageOptionResponse(value, 'q', receipt));
        expect(result.metadata).toMatchObject({ name: 'new title', messageOptionResponses: { other: receipt, q: receipt } });
        expect(withMessageOptionResponse(result.metadata, 'q', { status: 'dismissed', updatedAt: 11 })).toBe(result.metadata);
    });
});
