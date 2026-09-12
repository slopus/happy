import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

import { applyBrowserZoom, DEFAULT_APP_ZOOM } from './useTauriZoom';

describe('useTauriZoom browser defaults', () => {
    it('keeps browser CSS zoom fixed at 1x while desktop uses the Tauri default', () => {
        const properties = new Map<string, string>();
        const classes = new Set<string>();
        const root = {
            style: {
                getPropertyValue: (key: string) => properties.get(key) ?? '',
                removeProperty: (key: string) => {
                    properties.delete(key);
                    return '';
                },
                setProperty: (key: string, value: string) => properties.set(key, value),
            },
            classList: {
                add: (className: string) => classes.add(className),
                contains: (className: string) => classes.has(className),
                remove: (className: string) => classes.delete(className),
            },
        } as unknown as Pick<HTMLElement, 'style' | 'classList'>;

        expect(DEFAULT_APP_ZOOM).toBe(0.75);

        const cleanup = applyBrowserZoom(root);

        expect(root.style.getPropertyValue('--happy-app-zoom')).toBe('1');
        expect(root.classList.contains('happy-app-zoomed')).toBe(true);

        cleanup();

        expect(root.style.getPropertyValue('--happy-app-zoom')).toBe('');
        expect(root.classList.contains('happy-app-zoomed')).toBe(false);
    });
});
