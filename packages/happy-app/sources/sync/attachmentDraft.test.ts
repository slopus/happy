import { describe, it, expect } from 'vitest';
import { parsePersistedAttachments } from './attachmentDraft';
import type { AttachmentPreview } from './attachmentTypes';

const valid: AttachmentPreview = {
    id: 'a1',
    uri: 'file:///tmp/a.jpg',
    width: 100,
    height: 200,
    mimeType: 'image/jpeg',
    size: 1234,
    name: 'a.jpg',
    thumbhash: 'abc',
};

describe('parsePersistedAttachments', () => {
    it('round-trips a well-formed attachment via JSON', () => {
        const out = parsePersistedAttachments(JSON.parse(JSON.stringify([valid])));
        expect(out).toEqual([valid]);
    });

    it('keeps a valid attachment without an optional thumbhash', () => {
        const { thumbhash, ...noHash } = valid;
        const out = parsePersistedAttachments([noHash]);
        expect(out).toHaveLength(1);
        expect(out[0]).not.toHaveProperty('thumbhash');
        expect(out[0].id).toBe('a1');
    });

    it('drops a thumbhash that is not a string', () => {
        const out = parsePersistedAttachments([{ ...valid, thumbhash: 42 }]);
        expect(out[0]).not.toHaveProperty('thumbhash');
    });

    it('returns [] for non-array input', () => {
        expect(parsePersistedAttachments(undefined)).toEqual([]);
        expect(parsePersistedAttachments(null)).toEqual([]);
        expect(parsePersistedAttachments('nope')).toEqual([]);
        expect(parsePersistedAttachments({ id: 'x' })).toEqual([]);
    });

    it('filters out malformed entries but keeps valid ones', () => {
        const out = parsePersistedAttachments([
            valid,
            null,
            'string',
            { id: 'missing-fields' },
            { ...valid, id: 'b2', width: '100' }, // wrong type → dropped
            { ...valid, id: 'b3' }, // valid
        ]);
        expect(out.map((a) => a.id)).toEqual(['a1', 'b3']);
    });

    it('returns a fresh array (not the input reference)', () => {
        const input = [valid];
        const out = parsePersistedAttachments(input);
        expect(out).not.toBe(input);
        expect(out[0]).not.toBe(valid);
    });
});
