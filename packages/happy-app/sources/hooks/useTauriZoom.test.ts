import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

import { BROWSER_APP_ZOOM, getBrowserAppZoomValue } from './useTauriZoom';

describe('useTauriZoom browser defaults', () => {
    it('keeps browser web zoom fixed at 1x', () => {
        expect(BROWSER_APP_ZOOM).toBe(1);
        expect(getBrowserAppZoomValue()).toBe('1');
    });
});

describe('browser page height', () => {
    it('sizes the zoomed body to the visible viewport, not the toolbar-hidden one', async () => {
        const { readFileSync } = await import('node:fs');
        const css = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
        const rule = css.match(/html\.happy-app-zoomed body \{([^}]*)\}/)?.[1] ?? '';
        const heights = [...rule.matchAll(/height:\s*([^;]+);/g)].map((m) => m[1].trim());
        // The last declaration wins; 100vh before it is the fallback for browsers without dvh.
        expect(heights.at(-1)).toBe('calc(100dvh / var(--happy-app-zoom))');
    });
});
