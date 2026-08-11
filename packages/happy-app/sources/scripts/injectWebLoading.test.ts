import { describe, expect, it } from 'vitest';
import { ACCENTS } from '../themePacksData';
import {
    buildLissajousPath,
    createLoadingPlaceholder,
    injectWebLoading,
    resolveLoadingThemeName,
} from './injectWebLoading';

describe('injectWebLoading', () => {
    it('adds the curve loader after the Expo root', () => {
        const output = injectWebLoading('<body><div id="root"></div></body>');

        expect(output).toContain('<div id="root"></div>\n    <div id="app-loading"');
        expect(output).toContain('id="app-loading-curve"');
        expect(output).toContain('role="progressbar" aria-label="Paws"');
        expect(output).toContain('@media (prefers-reduced-motion: reduce)');
        expect(output).not.toContain('Paws 加载中…');
    });

    it('renders a stable particle trail with only the first-paint theme bootstrap', () => {
        const placeholder = createLoadingPlaceholder();

        expect(placeholder.match(/<circle r=/g)).toHaveLength(36);
        expect(placeholder.match(/<animateMotion /g)).toHaveLength(36);
        expect(placeholder.match(/<animateMotion path="/g)).toHaveLength(36);
        expect(placeholder).not.toContain('<mpath');
        expect(placeholder.match(/<script /g)).toHaveLength(1);
        expect(placeholder).toContain('id="app-loading-theme-bootstrap"');
        expect(placeholder).toContain('mmkv.default\\\\local-settings');
    });

    it('honors an explicit light preference on a dark OS', () => {
        expect(resolveLoadingThemeName(JSON.stringify({
            themePreference: 'light',
            themePack: 'caramel',
        }), true)).toBe('caramelLight');
    });

    it('honors an explicit dark preference on a light OS', () => {
        expect(resolveLoadingThemeName(JSON.stringify({
            themePreference: 'dark',
            themePack: 'caramel',
        }), false)).toBe('caramelDark');
    });

    it('uses a persisted non-default theme pack', () => {
        expect(resolveLoadingThemeName(JSON.stringify({
            themePreference: 'dark',
            themePack: 'gingham',
        }), false)).toBe('ginghamDark');
    });

    it('falls back safely for missing or malformed settings', () => {
        expect(resolveLoadingThemeName(null, false)).toBe('caramelLight');
        expect(resolveLoadingThemeName('{broken', true)).toBe('caramelDark');
        expect(resolveLoadingThemeName(JSON.stringify({
            themePreference: 'sepia',
            themePack: 'unknown',
        }), false)).toBe('caramelLight');
    });

    it('generates loader colors from the shared theme pack data', () => {
        const placeholder = createLoadingPlaceholder();
        const gingham = ACCENTS.find((accent) => accent.id === 'gingham');

        expect(gingham).toBeDefined();
        expect(placeholder).toContain('html[data-paws-loader-theme="ginghamDark"] #app-loading');
        expect(placeholder).toContain(`--app-loading-bg: ${gingham!.dark.bg}`);
        expect(placeholder).toContain(`--app-loading-fg: ${gingham!.dark.text}`);
        expect(placeholder).toContain(`--app-loading-particle-a: ${gingham!.dark.particleA}`);
        expect(placeholder).toContain(`--app-loading-particle-b: ${gingham!.dark.particleB}`);
    });

    it('builds the selected 3 by 4 Lissajous curve', () => {
        const path = buildLissajousPath();

        expect(path.startsWith('M78.00 50.00')).toBe(true);
        expect(path).toContain('L50.00 50.00');
        expect(path.match(/[ML]/g)).toHaveLength(181);
    });

    it('is idempotent', () => {
        const once = injectWebLoading('<div id="root"></div>');

        expect(injectWebLoading(once)).toBe(once);
    });

    it('rejects an unexpected Expo template', () => {
        expect(() => injectWebLoading('<div id="app"></div>')).toThrow(
            'could not find the <div id="root"></div> anchor',
        );
    });
});
