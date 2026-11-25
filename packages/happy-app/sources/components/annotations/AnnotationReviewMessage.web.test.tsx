// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (v: Record<string, unknown>) => v.web ?? v.default } }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { useUnistyles: () => ({ theme: appThemes.ginghamDark }) };
});
vi.mock('@/text', () => ({ t: () => '所选文本' }));

import { AnnotationReviewMessage } from './AnnotationReviewMessage.web';
import { appThemes } from '@/themePacks';
import type { AnnotationReview } from './annotationMessage';

const review: AnnotationReview = { version: 1, items: [
    { id: 'first', messageId: 'reply-1', quote: '第一段原文\n换行和 delegate_task 都完整保留。'.repeat(10), comment: '这个设计是什么意思？' },
    { id: 'second', messageId: 'reply-2', filePath: '/workspace/docs/方案.md', quote: '只能是 Codex 吗？', comment: '也支持 AGY 吗？\n请举一个例子。' },
], text: 'paws daemon 是不是本来就有？' };
let root: Root, mount: HTMLDivElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
});
afterEach(() => { act(() => root.unmount()); mount.remove(); });

describe('sent annotation presentation', () => {
    it('pairs each full passage with its comment, retaining additional instructions and source labels', () => {
        act(() => root.render(<AnnotationReviewMessage review={review} />));
        const items = mount.querySelectorAll('[data-testid=annotation-review-item]');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('[data-testid=annotation-review-quote]')?.textContent).toBe(review.items[0].quote);
        expect(items[0].querySelector('[data-testid=annotation-review-comment]')?.textContent).toBe(review.items[0].comment);
        expect(items[1].querySelector('[data-testid=annotation-review-comment]')?.textContent).toBe(review.items[1].comment);
        expect(mount.querySelector('[data-testid=annotation-review-file]')?.textContent).toBe('docs/方案.md');
        expect(mount.querySelector('[data-testid=annotation-review-additional]')?.textContent).toBe(review.text);
        expect(mount.textContent).not.toContain('用户评论');
        expect(mount.textContent).not.toContain('批注 1');
    });

    it('uses a reversible native disclosure instead of deleting long quote text', () => {
        act(() => root.render(<AnnotationReviewMessage review={review} />));
        const details = mount.querySelector('details')!;
        const summary = details.querySelector('summary')!;
        expect(details.open).toBe(false);
        expect(summary.title).toBe('所选文本 1');
        expect(summary.getAttribute('aria-label')).toBeNull();
        expect(summary.textContent).toContain(review.items[0].quote);
        const quote = details.querySelector('[data-testid=annotation-review-quote]')!;
        expect(getComputedStyle(quote).display).toBe('-webkit-box');
        act(() => summary.click());
        expect(details.open).toBe(true);
        expect(getComputedStyle(quote).display).toBe('block');
        expect(details.querySelector('[data-testid=annotation-review-quote]')?.textContent).toBe(review.items[0].quote);
        act(() => summary.click());
        expect(details.open).toBe(false);
    });

    it('keeps annotation-only messages visible and escapes quoted HTML', () => {
        act(() => root.render(<AnnotationReviewMessage review={{ version: 1, text: '', items: [
            { id: 'only', messageId: 'reply', quote: '<script>alert(1)</script>', comment: '解释这段内容' },
        ] }} />));
        expect(mount.querySelectorAll('[data-testid=annotation-review-item]')).toHaveLength(1);
        expect(mount.querySelector('[data-testid=annotation-review-additional]')).toBeNull();
        expect(mount.querySelector('script')).toBeNull();
        expect(mount.querySelector('[data-testid=annotation-review-quote]')?.textContent).toBe('<script>alert(1)</script>');
    });

    it('uses the current non-default dark theme for surfaces, focus and text', () => {
        act(() => root.render(<AnnotationReviewMessage review={review} />));
        const details = mount.querySelector('details')!;
        expect(details.style.getPropertyValue('--review-background')).toBe(appThemes.ginghamDark.colors.surface);
        expect(details.style.getPropertyValue('--review-hover')).toBe(appThemes.ginghamDark.colors.surfacePressed);
        expect(details.style.getPropertyValue('--review-selected')).toBe(appThemes.ginghamDark.colors.surfaceSelected);
        expect(details.style.getPropertyValue('--review-focus')).toBe(appThemes.ginghamDark.colors.textLink);
        expect(mount.querySelector('[data-testid=annotation-review-message]')?.getAttribute('style')).toContain('system-ui');
    });
});
