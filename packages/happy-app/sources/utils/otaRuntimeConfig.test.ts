import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('../../', import.meta.url));

function loadExpoVariant(variant: string) {
    const output = execFileSync(
        process.execPath,
        [
            '-e',
            [
                "const loaded = require('./app.config.js');",
                'const exported = loaded.default || loaded;',
                'const config = exported.expo || exported;',
                'process.stdout.write(JSON.stringify({',
                '  name: config.name,',
                '  androidPackage: config.android.package,',
                '  otaChannel: config.updates.requestHeaders[\'expo-channel-name\'],',
                '  runtimeVersion: config.runtimeVersion,',
                '}));',
            ].join('\n'),
        ],
        {
            cwd: appRoot,
            encoding: 'utf8',
            env: { ...process.env, APP_ENV: variant },
        }
    );
    return JSON.parse(output);
}

const BUILD_VARIANT_CONTRACT_EXPECTED = {
    development: {
        name: 'Paws (dev)',
        androidPackage: 'build.paws.dev',
        otaChannel: 'preview',
        runtimeVersion: '22',
    },
    preview: {
        name: 'Paws (preview)',
        androidPackage: 'build.paws.preview',
        otaChannel: 'preview',
        runtimeVersion: '22',
    },
    production: {
        name: 'Paws',
        androidPackage: 'build.paws',
        otaChannel: 'production',
        runtimeVersion: '23',
    },
} as const;

describe('OTA native runtime isolation', () => {
    it('moves every build variant off the runtime used before expo-media-library', () => {
        const {
            BUILD_VARIANT_CONTRACT,
            OTA_RUNTIME_VERSION_BY_VARIANT,
            assertVariantOtaTarget,
            defaultRuntimeVersion,
            getBuildVariantConfig,
        } = require('../../scripts/ota-runtime-config.js');

        expect(OTA_RUNTIME_VERSION_BY_VARIANT).toEqual({
            development: '22',
            preview: '22',
            production: '23',
        });
        expect(defaultRuntimeVersion('preview')).toBe('22');
        expect(defaultRuntimeVersion('production')).toBe('23');
        expect(BUILD_VARIANT_CONTRACT).toEqual({
            development: {
                appName: 'Paws (dev)',
                androidPackage: 'build.paws.dev',
                otaChannel: 'preview',
                runtimeVersion: '22',
            },
            preview: {
                appName: 'Paws (preview)',
                androidPackage: 'build.paws.preview',
                otaChannel: 'preview',
                runtimeVersion: '22',
            },
            production: {
                appName: 'Paws',
                androidPackage: 'build.paws',
                otaChannel: 'production',
                runtimeVersion: '23',
            },
        });
        expect(getBuildVariantConfig('preview')).toBe(BUILD_VARIANT_CONTRACT.preview);
        expect(() => getBuildVariantConfig('staging')).toThrow('Unknown APP_ENV variant');
        expect(() => assertVariantOtaTarget('preview', 'preview', '22')).not.toThrow();
        expect(() => assertVariantOtaTarget('preview', 'production', '23')).toThrow('OTA target mismatch');

        const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
        expect(appConfig).toContain('getBuildVariantConfig');
        expect(appConfig).toContain('const buildVariant = getBuildVariantConfig(variant);');
        expect(appConfig).toContain('runtimeVersion: otaRuntimeVersion');

        const otaSite = readFileSync(new URL('../../ota-server/site/index.html', import.meta.url), 'utf8');
        expect(otaSite).toContain("const PREFIX = 'meta/android/22/preview/';");
    });

    it.each([
        ['development', BUILD_VARIANT_CONTRACT_EXPECTED.development],
        ['preview', BUILD_VARIANT_CONTRACT_EXPECTED.preview],
        ['production', BUILD_VARIANT_CONTRACT_EXPECTED.production],
    ])('renders the %s package/channel/runtime contract in Expo config', (variant, expected) => {
        expect(loadExpoVariant(variant)).toEqual(expected);
    });

    it('pins OTA workflows and package scripts to matching variants and channels', () => {
        const previewWorkflow = readFileSync(
            new URL('../../../../.github/workflows/ota-preview.yml', import.meta.url),
            'utf8'
        );
        const productionWorkflow = readFileSync(
            new URL('../../../../.github/workflows/ota-production.yml', import.meta.url),
            'utf8'
        );
        const packageJson = JSON.parse(
            readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
        );

        expect(previewWorkflow).not.toContain('github.event.inputs.channel');
        expect(previewWorkflow).toContain('--variant preview --channel preview');
        expect(previewWorkflow).toContain("github.head_ref != 'automation/sync-image-effects'");
        expect(productionWorkflow).not.toContain('github.event.inputs.channel');
        expect(productionWorkflow).toContain('--variant production --channel production');
        expect(packageJson.scripts['ota:selfhost:preview']).toContain('--variant preview --channel preview');
        expect(packageJson.scripts['ota:selfhost']).toContain('--variant production --channel production');
    });
});
