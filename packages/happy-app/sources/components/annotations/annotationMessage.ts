import { z } from 'zod';
import type { AnnotationPromptLabels, MessageAnnotation } from './annotationDraft';

/** UI-only context, stored inside the encrypted message alongside the full prompt. */
export const AnnotationReviewSchema = z.object({
    version: z.literal(1),
    items: z.array(z.object({
        id: z.string().min(1),
        messageId: z.string().min(1),
        quote: z.string().min(1),
        comment: z.string(),
        filePath: z.string().optional(),
    })).min(1),
    text: z.string(),
});

export type AnnotationReview = z.infer<typeof AnnotationReviewSchema>;

export function createAnnotationReview(
    text: string,
    annotations: readonly MessageAnnotation[],
    labels: Pick<AnnotationPromptLabels, 'explain' | 'fileReview'>,
): AnnotationReview | undefined {
    if (!annotations.length) return undefined;
    return {
        version: 1,
        items: annotations.map(annotation => ({
            id: annotation.id,
            messageId: annotation.messageId,
            quote: annotation.quote,
            comment: annotation.comment.trim() || (annotation.file ? labels.fileReview ?? labels.explain : labels.explain),
            ...(annotation.file ? { filePath: annotation.file.path } : {}),
        })),
        text,
    };
}
