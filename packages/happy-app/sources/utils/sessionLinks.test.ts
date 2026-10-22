import { describe, expect, it } from 'vitest';
import { parseSessionLink } from './sessionLinks';
import { parseMarkdown, parseReadOnlyMarkdown } from '@/components/markdown/parseMarkdown';
const block = '<happy-session>\n{"sessionId":"child-1","title":"Task 1"}\n</happy-session>';
describe('independent session links', () => {
    it('parses separate cards between normal paragraphs', () => {
        const blocks = parseMarkdown(`Started\n${block}\n${block.replace('child-1', 'child-2')}\nDone`);
        expect(blocks.map(b => b.type)).toEqual(['text', 'session-link', 'session-link', 'text']);
    });
    it('does not turn external imported history into actionable cards', () => {
        expect(parseReadOnlyMarkdown(block)[0].type).toBe('code-block');
    });
    it.each(['{}', '{"sessionId":"../bad","title":"Task"}', '{"sessionId":"child","title":""}', 'broken'])('rejects invalid payload %s', content => {
        expect(parseSessionLink(content)).toBeNull();
    });
    it('keeps incomplete streaming content visible without creating a link', () => {
        expect(parseMarkdown(block.replace('</happy-session>', ''))[0].type).toBe('text');
    });
});
