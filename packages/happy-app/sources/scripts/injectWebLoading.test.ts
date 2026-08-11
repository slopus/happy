import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ACCENTS } from '../themePacksData';
import {
    buildLissajousPath,
    createLoadingPlaceholder,
    getLissajousPoint,
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

    it('renders a positioned particle trail with a portable animation bootstrap', () => {
        const placeholder = createLoadingPlaceholder();
        const positions = Array.from(placeholder.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g));

        expect(positions).toHaveLength(36);
        expect(new Set(positions.map((match) => `${match[1]},${match[2]}`)).size).toBeGreaterThan(30);
        expect(placeholder).not.toContain('<animateMotion');
        expect(placeholder).not.toContain('<mpath');
        expect(placeholder).not.toContain('<use');
        expect(placeholder.match(/<script /g)).toHaveLength(1);
        expect(placeholder).toContain('id="app-loading-bootstrap"');
        expect(placeholder).toContain('requestAnimationFrame');
        expect(placeholder).toContain('getPointAtLength');
        expect(placeholder).toContain('childElementCount');
        expect(placeholder).toContain('mmkv.default\\\\local-settings');
    });

    it('animates every particle without SVG SMIL and stops after React mounts', () => {
        const placeholder = createLoadingPlaceholder();
        const script = placeholder.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
        const frames: Array<(time: number) => void> = [];
        const root = { childElementCount: 0 };
        const curve = {
            getTotalLength: () => 100,
            getPointAtLength: (distance: number) => ({ x: distance, y: distance / 2 }),
        };
        const circles = Array.from({ length: 36 }, () => {
            const attributes: Record<string, string> = {};
            return {
                attributes,
                setAttribute: (name: string, value: string) => { attributes[name] = value; },
            };
        });
        const documentElement = { dataset: {} as Record<string, string> };
        const window = {
            matchMedia: () => ({ matches: false }),
            requestAnimationFrame: (frame: (time: number) => void) => {
                frames.push(frame);
                return frames.length;
            },
        };

        expect(script).toBeDefined();
        runInNewContext(script!, {
            Array,
            JSON,
            document: {
                documentElement,
                getElementById: (id: string) => id === 'root' ? root : curve,
                querySelectorAll: () => circles,
            },
            localStorage: { getItem: () => null },
            performance: { now: () => 100 },
            window,
        });

        expect(documentElement.dataset.pawsLoaderTheme).toBe('caramelLight');
        expect(frames).toHaveLength(1);
        frames.shift()!(1100);
        expect(circles.every((circle) => circle.attributes.cx && circle.attributes.cy)).toBe(true);
        expect(new Set(circles.map((circle) => circle.attributes.cx)).size).toBeGreaterThan(30);

        root.childElementCount = 1;
        expect(frames).toHaveLength(1);
        frames.shift()!(1200);
        expect(frames).toHaveLength(0);
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
        const start = getLissajousPoint(0);

        expect(start).toEqual({ x: 78, y: 50 });
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
