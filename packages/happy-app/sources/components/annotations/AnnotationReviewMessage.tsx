import type { AnnotationReview } from './annotationMessage';

export type AnnotationReviewMessageProps = { review: AnnotationReview };

// Native clients retain the existing readable displayText fallback.
export function AnnotationReviewMessage(_props: AnnotationReviewMessageProps) {
    return null;
}
