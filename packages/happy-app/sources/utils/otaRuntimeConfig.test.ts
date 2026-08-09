import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('OTA native runtime isolation', () => {
    it('moves every build variant off the runtime used before expo-media-library', () => {
        const {
            OTA_RUNTIME_VERSION_BY_VARIANT,
            defaultRuntimeVersion,
        } = require('../../scripts/ota-runtime-config.js');

        expect(OTA_RUNTIME_VERSION_BY_VARIANT).toEqual({
            development: '22',
            preview: '22',
            production: '23',
        });
        expect(defaultRuntimeVersion('preview')).toBe('22');
        expect(defaultRuntimeVersion('production')).toBe('23');

        const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
        expect(appConfig).toContain("require('./scripts/ota-runtime-config.js')");
        expect(appConfig).toContain('const otaRuntimeVersion = OTA_RUNTIME_VERSION_BY_VARIANT[variant];');
        expect(appConfig).toContain('runtimeVersion: otaRuntimeVersion');

        const otaSite = readFileSync(new URL('../../ota-server/site/index.html', import.meta.url), 'utf8');
        expect(otaSite).toContain("const PREFIX = 'meta/android/22/preview/';");
    });
});
