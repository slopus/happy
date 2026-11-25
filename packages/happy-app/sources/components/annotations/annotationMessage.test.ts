import { describe, expect, it } from 'vitest';
import { createAnnotationReview } from './annotationMessage';
import { fileAnnotationSourceId, type MessageAnnotation } from './annotationDraft';
import { MessageMetaSchema } from '@/sync/typesMessageMeta';

describe('encrypted annotation presentation', () => {
    it('keeps complete quote/comment pairs and supplemental text through the message metadata schema', () => {
        const file = { path: '/work/spec.md', hash: 'source-revision' };
        const annotation: MessageAnnotation = {
            id: 'a', revision: 2, messageId: fileAnnotationSourceId(file), file,
            quote: 'First line\nSecond line with `code`', anchorText: 'First line', start: 0, end: 10,
            comment: '  Make this concrete\nUse an example  ',
        };
        const review = createAnnotationReview('Apply together', [annotation, {
            ...annotation, id: 'b', file: undefined, messageId: 'earlier-reply', comment: '',
        }], { explain: 'Explain this passage', fileReview: 'Review this passage' });
        const restored = MessageMetaSchema.parse(JSON.parse(JSON.stringify({ annotationReview: review }))).annotationReview!;
        expect(restored).toEqual({
            version: 1,
            items: [
                { id: 'a', messageId: annotation.messageId, quote: annotation.quote, comment: 'Make this concrete\nUse an example', filePath: '/work/spec.md' },
                { id: 'b', messageId: 'earlier-reply', quote: annotation.quote, comment: 'Explain this passage' },
            ],
            text: 'Apply together',
        });
        expect(restored.items[0]).not.toHaveProperty('file');
    });

    it('keeps annotation-only reviews and omits presentation metadata for ordinary messages', () => {
        const annotation = { id: 'a', revision: 0, messageId: 'reply', quote: 'Original', anchorText: 'Original', start: 0, end: 8, comment: '' };
        expect(createAnnotationReview('', [annotation], { explain: 'Explain' })).toMatchObject({ text: '', items: [{ quote: 'Original', comment: 'Explain' }] });
        expect(createAnnotationReview('Plain request', [], { explain: 'Explain' })).toBeUndefined();
        expect(MessageMetaSchema.parse({ displayText: 'Plain request' })).not.toHaveProperty('annotationReview');
    });
});
