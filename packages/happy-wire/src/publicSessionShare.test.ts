import { describe, expect, it } from 'vitest';
import { publicSessionSnapshotSchema } from './publicSessionShare';

const legacySnapshot = {
    version: 1 as const,
    title: 'Release review',
    sharedAt: 1_788_192_000_000,
    presentation: { groupToolCalls: true },
    messages: [{
        id: 'message-1',
        role: 'assistant' as const,
        createdAt: 1_788_192_000_000,
        blocks: [{ type: 'text' as const, markdown: 'Ready.' }],
    }],
};

describe('publicSessionSnapshotSchema', () => {
    it('keeps existing version-one snapshots valid without source metadata', () => {
        expect(publicSessionSnapshotSchema.parse(legacySnapshot)).toEqual(legacySnapshot);
    });

    it.each(['paws', 'codex', 'claude-code'] as const)('accepts the display-safe %s provider label', (provider) => {
        expect(publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            source: { provider },
        }).source).toEqual({ provider });
    });

    it('rejects private provider identifiers in source metadata', () => {
        expect(() => publicSessionSnapshotSchema.parse({
            ...legacySnapshot,
            source: { provider: 'codex', sessionId: 'private-session-id' },
        })).toThrow();
    });
});
