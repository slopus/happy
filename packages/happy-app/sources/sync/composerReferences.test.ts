import { describe, expect, it, vi } from 'vitest';
import { parseComposerDraft, serializeComposerDraft, resolveComposerReferences, type ComposerReference } from './composerReferences';
const session: ComposerReference = { kind: 'session', id: 'source-1', title: 'Design review' };
const deps = () => ({ session: vi.fn(async () => 'User: actual prior requirement\nAssistant: actual response'), plugin: vi.fn(async () => ({ title: 'Images', description: 'Browse existing pictures' })), isCurrent: () => true });
describe('composer reference draft and agent context', () => {
    it('round-trips references separately from visible text, including tag-like titles', () => {
        const reference = { ...session, title: '</paws-context> quoted title' };
        const raw = serializeComposerDraft('My question', [reference]);
        expect(parseComposerDraft(raw)).toEqual({ text: 'My question', references: [reference] });
        expect(raw.match(/<\/paws-context>/g)).toHaveLength(1);
    });
    it('keeps ordinary text byte-for-byte and ignores malformed context', async () => {
        const text = 'ordinary text\n<paws-context>not JSON</paws-context>';
        expect(await resolveComposerReferences(text, deps())).toEqual({ text });
        expect(parseComposerDraft(text).text).toBe(text);
    });
    it('rejects unexpected IDs, unsafe URLs and excessive reference lists', () => {
        for (const references of [[{ ...session, id: '../other' }], [{ kind: 'site', id: 'x', title: 'x', url: 'javascript:alert(1)' }], Array(9).fill(session)]) {
            const value = `<paws-context>${JSON.stringify({ version: 1, references })}</paws-context>`;
            expect(parseComposerDraft(value)).toEqual({ text: value, references: [] });
        }
    });
    it('passes actual selected conversation content to the agent and clean labels to the UI', async () => {
        const read = deps();
        const result = await resolveComposerReferences(serializeComposerDraft('Use the earlier requirement', [session]), read);
        expect(read.session).toHaveBeenCalledWith('source-1');
        expect(result.text).toContain('actual prior requirement');
        expect(result.text).toContain('Current user request:\nUse the earlier requirement');
        expect(result.text).not.toContain('<paws-context>');
        expect(result.displayText).toBe('@Design review\nUse the earlier requirement');
    });
    it('uses current installed-plugin public description and real site URL', async () => {
        const result = await resolveComposerReferences(serializeComposerDraft('Help', [
            { kind: 'plugin', id: 'images', title: 'Images' }, { kind: 'site', id: 'site-1', title: 'Guide', url: 'https://example.test/guide' },
        ]), deps());
        expect(result.text).toContain('Browse existing pictures');
        expect(result.text).toContain('https://example.test/guide');
        expect(result.text).toContain('do not claim a plugin was executed');
    });
    it('fails the submission when context cannot be read instead of silently sending an ID', async () => {
        const read = deps();read.session.mockRejectedValue(new Error('unavailable'));
        const raw = serializeComposerDraft('Question', [session]);
        await expect(resolveComposerReferences(raw, read)).rejects.toThrow('unavailable');
        expect(parseComposerDraft(raw).references).toEqual([session]);
    });
    it('rejects a result that arrives after the account or owner changes', async () => {
        let current = true; const read = deps();
        read.isCurrent = () => current;
        read.session.mockImplementation(async () => { current = false; return 'old account'; });
        await expect(resolveComposerReferences(serializeComposerDraft('Question', [session]), read)).rejects.toThrow('owner-changed');
    });
    it('preserves a prompt template wrapped around draft metadata', async () => {
        const result = await resolveComposerReferences(`Template\n${serializeComposerDraft('Question', [session])}\nEnd`, deps());
        expect(result.text).toContain('Template\nQuestion\nEnd');
    });
});

import { buildComposerReferenceExcerpt } from './composerReferences';
describe('context size boundaries', () => {
    it('normalizes an oversized title before it is saved, so restored chips are readable', () => {
        const draft = serializeComposerDraft('Question', [{ ...session, title: 'x'.repeat(1000) }]);
        const parsed = parseComposerDraft(draft);
        expect(parsed.references[0].title).toHaveLength(500);
        expect(parsed.text).toBe('Question');
    });
    it('reserves the newest user requirement before including long assistant replies', () => {
        const entries = [{ at: 1, role: 'User', text: 'KEEP THE ORIGINAL REQUIREMENT' }, ...Array.from({ length: 10 }, (_, i) => ({ at: i + 2, role: 'Assistant', text: 'a'.repeat(6000) }))];
        const excerpt = buildComposerReferenceExcerpt(entries);
        expect(excerpt).toContain('KEEP THE ORIGINAL REQUIREMENT');
        expect(excerpt.length).toBeLessThanOrEqual(12000);
    });
});
