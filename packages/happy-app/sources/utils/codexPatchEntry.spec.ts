import { describe, expect, it } from 'vitest';
import {
    getPatchChanges,
    getPatchInput,
    getPatchKindLabel,
    looksLikeUnifiedDiff,
} from './codexPatchEntry';

describe('looksLikeUnifiedDiff', () => {
    it('recognises a hunk header anywhere in the text', () => {
        expect(looksLikeUnifiedDiff('@@ -1 +1,45 @@\n-old\n+new')).toBe(true);
        expect(looksLikeUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@')).toBe(true);
        expect(looksLikeUnifiedDiff('diff --git a/x b/x')).toBe(true);
    });

    it('rejects plain file bodies, even ones that start with punctuation', () => {
        // The payload that made new files render as "no changes".
        expect(looksLikeUnifiedDiff('.DS_Store\n\n# Environment files\n.env\n')).toBe(false);
        expect(looksLikeUnifiedDiff('# Tests\n\nPlace automated tests here.\n')).toBe(false);
        // A body that merely mentions @@ mid-line is still not a diff.
        expect(looksLikeUnifiedDiff('const email = "a@@b";\n')).toBe(false);
    });
});

describe('getPatchInput', () => {
    it('treats an update diff as a patch', () => {
        const change = {
            kind: { type: 'update', move_path: null },
            diff: '@@ -13,3 +13,3 @@\n context\n-was\n+is\n',
        };
        expect(getPatchInput(change)).toEqual({ kind: 'patch', patch: change.diff });
    });

    it('treats an added file body as new content, not as a patch', () => {
        // Codex puts the whole file in `diff` when the kind is `add`.
        const body = '.DS_Store\n\n# Environment files\n.env\n';
        expect(getPatchInput({ kind: { type: 'add' }, diff: body })).toEqual({
            kind: 'pair',
            oldText: '',
            newText: body,
        });
    });

    it('treats a deleted file body as removed content', () => {
        const body = 'export const OLD = 1;\n';
        expect(getPatchInput({ kind: { type: 'delete' }, diff: body })).toEqual({
            kind: 'pair',
            oldText: body,
            newText: '',
        });
    });

    it('still honours a real unified diff on an add', () => {
        // Some providers do send a proper diff for new files; keep parsing it.
        const diff = '@@ -0,0 +1,2 @@\n+first\n+second\n';
        expect(getPatchInput({ kind: { type: 'add' }, diff })).toEqual({ kind: 'patch', patch: diff });
    });

    it('reads the explicit add/modify/delete shapes', () => {
        expect(getPatchInput({ add: { content: 'x\n' } })).toEqual({ kind: 'pair', oldText: '', newText: 'x\n' });
        expect(getPatchInput({ modify: { old_content: 'a', new_content: 'b' } })).toEqual({
            kind: 'pair', oldText: 'a', newText: 'b',
        });
        expect(getPatchInput({ delete: { content: 'gone\n' } })).toEqual({
            kind: 'pair', oldText: 'gone\n', newText: '',
        });
    });

    it('returns null when there is nothing to show', () => {
        expect(getPatchInput({ kind: { type: 'update' } })).toBeNull();
    });
});

describe('getPatchKindLabel', () => {
    it('names each kind, and calls a moved file a move', () => {
        expect(getPatchKindLabel({ kind: { type: 'add' } })).toBe('new');
        expect(getPatchKindLabel({ kind: { type: 'delete' } })).toBe('delete');
        expect(getPatchKindLabel({ kind: { type: 'update' } })).toBe('edit');
        expect(getPatchKindLabel({ kind: { type: 'update', move_path: 'b.ts' } })).toBe('move');
    });
});

describe('getPatchChanges', () => {
    it('accepts the map shape', () => {
        const changes = getPatchChanges({ changes: { 'a.ts': { kind: { type: 'add' }, diff: 'x' } } });
        expect(Object.keys(changes ?? {})).toEqual(['a.ts']);
    });

    it('accepts the list shape and keys it by path', () => {
        const changes = getPatchChanges({
            changes: [{ path: 'a.ts', type: 'add', content: 'x\n' }],
        });
        expect(changes?.['a.ts']?.add).toEqual({ content: 'x\n' });
    });

    it('returns null when there is no change map at all', () => {
        expect(getPatchChanges({})).toBeNull();
        expect(getPatchChanges({ changes: [] })).toBeNull();
    });
});
