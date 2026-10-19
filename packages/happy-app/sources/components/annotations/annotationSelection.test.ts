// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { annotationRange, readAnnotationSelection } from './annotationSelection';
import type { MessageAnnotation } from './annotationDraft';

beforeEach(() => {
    document.body.innerHTML = '<main><div id="source"><p>same <strong>text</strong></p><p>same text</p><button>action</button></div><div id="outside">other</div></main>';
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 1, top: 2, bottom: 3 }) });
    getSelection()!.removeAllRanges();
});
function select(range: Range) { getSelection()!.removeAllRanges(); getSelection()!.addRange(range); }
const root = () => document.getElementById('source')!;
describe('rendered Markdown annotation anchors', () => {
    it('handles element boundaries spanning inline Markdown and survives a content remount', () => {
        const range = document.createRange(); range.selectNodeContents(root().querySelector('p')!); select(range);
        const selected = readAnnotationSelection(root(), 'reply', getSelection())!;
        expect(selected).toMatchObject({ quote: 'same text', anchorText: 'same text', start: 0, end: 9 });
        root().innerHTML = root().innerHTML;
        const restored = annotationRange(root(), { ...selected, id: 'a', revision: 0, comment: '' });
        expect(restored!.toString()).toBe('same text');
        expect(restored!.endContainer.parentElement!.tagName).toBe('STRONG');
    });
    it('locates repeated text by exact offsets and refuses stale anchors instead of highlighting a different passage', () => {
        const n = root().querySelectorAll('p')[1].firstChild!;
        const range = document.createRange(); range.setStart(n, 0); range.setEnd(n, 9); select(range);
        const selected = readAnnotationSelection(root(), 'reply', getSelection())!;
        expect(selected.start).toBe(9);
        const item: MessageAnnotation = { ...selected, id: 'a', revision: 0, comment: '' };
        expect(annotationRange(root(), item)!.startContainer).toBe(n);
        root().querySelector('p')!.textContent = 'changed prefix';
        expect(annotationRange(root(), item)).toBeNull();
    });
    it('ignores cross-message selections and interactive controls', () => {
        const range = document.createRange(); range.setStart(root().querySelector('p')!.firstChild!, 0); range.setEnd(document.getElementById('outside')!.firstChild!, 3); select(range);
        expect(readAnnotationSelection(root(), 'reply', getSelection())).toBeNull();
        range.selectNodeContents(root().querySelector('button')!); select(range);
        expect(readAnnotationSelection(root(), 'reply', getSelection())).toBeNull();
    });
});
