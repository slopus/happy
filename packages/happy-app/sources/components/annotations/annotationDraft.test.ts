import { describe, it, expect } from 'vitest';
import { createAnnotationDraftStore, fileAnnotationSourceId, formatAnnotatedMessage, type AnnotationSelection } from './annotationDraft';

const selection: AnnotationSelection = { messageId: 'reply-a', quote: 'same text', anchorText: 'same text', start: 0, end: 9 };
function fixture() {
    const disk = new Map<string, string>();
    let id = 0, current = true, fail = false;
    const create = () => createAnnotationDraftStore({ read: key => disk.get(key), write: (key, value) => { if (fail) throw Error('disk full'); disk.set(key, value); }, newId: () => `annotation-${++id}`, isCurrent: () => current });
    return { disk, create, stale: () => { current = false; }, fail: () => { fail = true; } };
}
describe('annotation draft ownership and submission', () => {
    it('restores saved comments per session and keeps identical passages distinct by location and message', () => {
        const f = fixture(), store = f.create();
        const first = store.add('a', selection);
        store.update('a', first.id, 'explain first');
        store.add('a', { ...selection, start: 20, end: 29 });
        store.add('a', { ...selection, messageId: 'reply-b' });
        expect(store.add('a', selection).id).toBe(first.id);
        expect(f.create().getSnapshot('a').map(a => a.comment)).toEqual(['explain first', '', '']);
        expect(store.getSnapshot('b')).toEqual([]);
        expect(fixture().create().getSnapshot('a')).toEqual([]);
    });
    it('clears only submitted versions, preserving edits and additions made during an async send', () => {
        const f = fixture(), store = f.create();
        const first = store.add('a', selection);
        store.add('a', { ...selection, messageId: 'second' });
        const snapshot = store.getSnapshot('a');
        store.update('a', first.id, 'newer comment');
        const third = store.add('a', { ...selection, messageId: 'third' });
        store.clearSubmitted('a', snapshot);
        expect(store.getSnapshot('a').map(a => [a.id, a.comment])).toEqual([[first.id, 'newer comment'], [third.id, '']]);
        expect(f.create().getSnapshot('a')).toEqual(store.getSnapshot('a'));
    });
    it('rejects stale-account writes and does not expose its cached drafts after account changes', () => {
        const f = fixture(), store = f.create();
        store.add('a', selection); f.stale();
        expect(store.getSnapshot('a')).toEqual([]);
        expect(() => store.add('a', selection)).toThrow('Account changed');
    });
    it('keeps the last saved version if persistence fails', () => {
        const f = fixture(), store = f.create(), item = store.add('a', selection);
        const before = store.getSnapshot('a'); f.fail();
        expect(() => store.update('a', item.id, 'not saved')).toThrow('disk full');
        expect(store.getSnapshot('a')).toBe(before);
        expect(f.create().getSnapshot('a')[0].comment).toBe('');
    });
    it('retires accepted versions in memory if cleanup persistence fails, retaining newer drafts', () => {
        const f = fixture(), store = f.create();
        store.add('a', selection);
        const submitted = store.getSnapshot('a');
        const newer = store.add('a', { ...selection, messageId: 'newer' });
        let notifications = 0;
        store.subscribe(() => { notifications++; });
        f.fail();
        expect(() => store.clearSubmitted('a', submitted)).toThrow('disk full');
        expect(store.getSnapshot('a').map(a => a.id)).toEqual([newer.id]);
        expect(notifications).toBe(1);
        // An entirely failing persistence layer cannot guarantee this across a
        // reload; the accepted-message warning explicitly discloses that limit.
        expect(f.create().getSnapshot('a')).toHaveLength(2);
    });
    it('treats corrupt or ambiguous persisted IDs as an empty cache', () => {
        const f = fixture(); f.disk.set('a', '{');
        expect(f.create().getSnapshot('a')).toEqual([]);
        const store = f.create(), item = store.add('b', selection);
        f.disk.set('c', JSON.stringify({ version: 1, items: [item, item] }));
        expect(f.create().getSnapshot('c')).toEqual([]);
    });
    it('keeps source/comment pairs and annotation-only payloads while preserving plain CLI commands', () => {
        const labels = { intro: 'Answer annotations', annotation: 'Annotation', quote: 'Selected text', comment: 'Comment', explain: 'Explain this passage', additional: 'Additional' };
        const store = fixture().create(), first = store.add('a', { ...selection, quote: 'line one\nline two' });
        store.update('a', first.id, 'my question');
        store.add('a', { ...selection, messageId: 'second' });
        const body = formatAnnotatedMessage('/status', store.getSnapshot('a'), labels);
        expect(body).toContain('> line one\n> line two\n\nComment\nmy question');
        expect(body).toContain('Annotation 2\nSelected text\n> same text\n\nComment\nExplain this passage');
        expect(body.startsWith('/')).toBe(false);
        expect(formatAnnotatedMessage('', store.getSnapshot('a'), labels)).not.toBe('');
        expect(formatAnnotatedMessage(' /status ', [], labels)).toBe(' /status ');
    });
});

describe('workspace file annotations', () => {
    const a = { path: '/work/first.md', hash: 'baseline-a' };
    const b = { path: '/work/second.md', hash: 'baseline-b' };
    const selected = (file: typeof a) => ({ ...selection, file, messageId: fileAnnotationSourceId(file) });
    it('persists multiple passages across files and keeps changed versions distinct', () => {
        const f = fixture(), store = f.create();
        const first = store.add('s', selected(a));
        store.update('s', first.id, 'Shorten this');
        store.add('s', { ...selected(a), start: 20, end: 29 });
        store.add('s', selected(b));
        store.add('s', selected({ ...a, hash: 'new-version' }));
        expect(store.add('s', selected(a)).id).toBe(first.id);
        expect(f.create().getSnapshot('s')).toHaveLength(4);
        expect(f.create().getSnapshot('s')[0]).toMatchObject({ file: a, comment: 'Shorten this' });
    });
    it('retains source identity in the payload and keeps baseline details out of display text', () => {
        const store = fixture().create();
        const first = store.add('s', selected(a));
        store.update('s', first.id, 'Shorten this');
        store.add('s', selected(b));
        const labels = { intro: 'Review annotations', annotation: 'Annotation', quote: 'Quote', comment: 'Comment', explain: 'Explain', additional: 'Additional', fileInstructions: 'Re-read the file', fileReview: 'Review this passage' };
        const payload = formatAnnotatedMessage('Apply together', store.getSnapshot('s'), labels);
        expect(payload).toContain(JSON.stringify({ ...a, renderedStart: 0, renderedEnd: 9 }));
        expect(payload).toContain('Shorten this');
        expect(payload).toContain('Review this passage');
        expect(payload).toContain('Re-read the file');
        const display = formatAnnotatedMessage('Apply together', store.getSnapshot('s'), labels, false);
        expect(display).toContain('work/first.md'); expect(display).toContain('work/second.md');
        expect(display).toContain('Shorten this'); expect(display).toContain('Apply together');
        expect(display).not.toContain('baseline-'); expect(display).not.toContain('renderedStart');
        expect(display).not.toContain('Re-read the file');
    });
    it('restores editable queued annotations without overwriting newer drafts', () => {
        const f = fixture(), store = f.create();
        const first = store.add('s', selected(a));
        store.update('s', first.id, 'Original comment');
        const submitted = store.getSnapshot('s');
        store.clearSubmitted('s', submitted);
        store.add('s', selected(b));
        store.restore('s', submitted);
        store.update('s', first.id, 'New comment');
        store.restore('s', submitted);
        expect(f.create().getSnapshot('s').map(a => a.comment)).toEqual(['', 'New comment']);
    });
    it('rejects persisted file metadata belonging to another source identity', () => {
        const f = fixture(), store = f.create();
        const item = store.add('s', selected(a));
        f.disk.set('s', JSON.stringify({ version: 1, items: [{ ...item, file: b }] }));
        expect(f.create().getSnapshot('s')).toEqual([]);
    });
});

it('saves a new file comment atomically and leaves no blank annotation if the write fails', () => {
    const f = fixture(), store = f.create();
    f.fail();
    expect(() => store.add('s', selection, 'Typed comment')).toThrow('disk full');
    expect(store.getSnapshot('s')).toEqual([]);
    expect(f.create().getSnapshot('s')).toEqual([]);
    const good = fixture().create();
    const item = good.add('s', selection, 'Typed comment');
    expect(item.comment).toBe('Typed comment');
    expect(good.getSnapshot('s')[0].comment).toBe('Typed comment');
});
