import { describe, expect, it } from 'vitest';
import { resolveUiConfig } from './uiConfig';

describe('resolveUiConfig', () => {
    it('returns null dir when UI is not configured', () => {
        const cfg = resolveUiConfig({});
        expect(cfg.dir).toBeNull();
    });

    it('uses HAPPY_SERVER_UI_DIR and defaults prefix to /', () => {
        const cfg = resolveUiConfig({ HAPPY_SERVER_UI_DIR: '/tmp/ui' });
        expect(cfg.dir).toBe('/tmp/ui');
        expect(cfg.mountRoot).toBe(true);
        expect(cfg.prefix).toBe('/');
    });

    it('normalizes a non-root prefix by stripping trailing slash', () => {
        const cfg = resolveUiConfig({ HAPPY_SERVER_UI_DIR: '/tmp/ui', HAPPY_SERVER_UI_PREFIX: '/ui/' });
        expect(cfg.mountRoot).toBe(false);
        expect(cfg.prefix).toBe('/ui');
    });

    it('supports legacy HAPPY_SERVER_LIGHT_UI_* env vars', () => {
        const cfg = resolveUiConfig({ HAPPY_SERVER_LIGHT_UI_DIR: '/tmp/ui', HAPPY_SERVER_LIGHT_UI_PREFIX: '/ui' });
        expect(cfg.dir).toBe('/tmp/ui');
        expect(cfg.mountRoot).toBe(false);
        expect(cfg.prefix).toBe('/ui');
    });
});

