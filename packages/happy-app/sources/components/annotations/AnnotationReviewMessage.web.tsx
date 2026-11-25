import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { AnnotationReviewMessageProps } from './AnnotationReviewMessage';

/** Presentation only: the full passages and comments still travel to the agent. */
export function AnnotationReviewMessage({ review }: AnnotationReviewMessageProps) {
    const { theme } = useUnistyles();
    const c = theme.colors;
    return <div data-testid="annotation-review-message" style={{
        ...Typography.default(), color: c.text, fontSize: 16, lineHeight: 1.6,
        minWidth: 0, padding: '6px 0', display: 'flex', flexDirection: 'column', gap: 16,
    }}>
        <style>{`
            .paws-review-quote > summary { list-style: none; cursor: pointer; background: var(--review-background); }
            .paws-review-quote > summary::-webkit-details-marker { display: none; }
            .paws-review-quote > summary:hover { background: var(--review-hover); }
            .paws-review-quote[open] > summary { background: var(--review-selected); }
            .paws-review-quote > summary:focus-visible { outline: 2px solid var(--review-focus); outline-offset: 2px; }
            .paws-review-preview { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; white-space: pre-wrap; }
            .paws-review-quote[open] .paws-review-preview { display: block; -webkit-line-clamp: unset; white-space: pre-wrap; }
            .paws-review-quote[open] .paws-review-chevron { transform: rotate(180deg); }
        `}</style>
        {review.items.map((item, index) => <div key={item.id} data-testid="annotation-review-item" style={{ minWidth: 0 }}>
            <details className="paws-review-quote" style={{
                '--review-background': c.surface, '--review-hover': c.surfacePressed,
                '--review-selected': c.surfaceSelected, '--review-focus': c.textLink,
            } as React.CSSProperties}>
                <summary title={`${t('messageAnnotations.selectedText')} ${index + 1}`} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
                    borderRadius: 8, color: c.textSecondary,
                    borderInlineStart: `2px solid ${c.divider}`, fontSize: 14, lineHeight: 1.55,
                    minWidth: 0, textAlign: 'start', overflowWrap: 'anywhere',
                }}>
                    <span style={{ minWidth: 0, flex: 1 }}>
                        {item.filePath && <span title={item.filePath} data-testid="annotation-review-file" style={{
                            display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontSize: 12, fontWeight: 500, marginBottom: 2,
                        }}>{item.filePath.split('/').slice(-2).join('/')}</span>}
                        <span className="paws-review-preview" data-testid="annotation-review-quote" dir="auto">{item.quote}</span>
                    </span>
                    <svg className="paws-review-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 4 }}>
                        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </summary>
            </details>
            {item.comment && <div data-testid="annotation-review-comment" dir="auto" style={{
                marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            }}>{item.comment}</div>}
        </div>)}
        {review.text.trim() && <div data-testid="annotation-review-additional" dir="auto" style={{
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            ...(review.items.length > 1 ? { borderTop: `1px solid ${c.divider}`, paddingTop: 12 } : {}),
        }}>{review.text}</div>}
    </div>;
}
