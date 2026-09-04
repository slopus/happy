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
        runtimeVersion: '23',
    },
    preview: {
        name: 'Paws (preview)',
        androidPackage: 'build.paws.preview',
        otaChannel: 'preview',
        runtimeVersion: '23',
    },
    production: {
        name: 'Paws',
        androidPackage: 'build.paws',
        otaChannel: 'production',
        runtimeVersion: '24',
    },
} as const;

describe('OTA native runtime isolation', () => {
    it('moves every build variant off the runtime used before the native scanner patch', () => {
        const {
            BUILD_VARIANT_CONTRACT,
            OTA_RUNTIME_VERSION_BY_VARIANT,
            assertVariantOtaTarget,
            defaultRuntimeVersion,
            getBuildVariantConfig,
        } = require('../../scripts/ota-runtime-config.js');

        expect(OTA_RUNTIME_VERSION_BY_VARIANT).toEqual({
            development: '23',
            preview: '23',
            production: '24',
        });
        expect(defaultRuntimeVersion('preview')).toBe('23');
        expect(defaultRuntimeVersion('production')).toBe('24');
        expect(BUILD_VARIANT_CONTRACT).toEqual({
            development: {
                appName: 'Paws (dev)',
                androidPackage: 'build.paws.dev',
                otaChannel: 'preview',
                runtimeVersion: '23',
            },
            preview: {
                appName: 'Paws (preview)',
                androidPackage: 'build.paws.preview',
                otaChannel: 'preview',
                runtimeVersion: '23',
            },
            production: {
                appName: 'Paws',
                androidPackage: 'build.paws',
                otaChannel: 'production',
                runtimeVersion: '24',
            },
        });
        expect(getBuildVariantConfig('preview')).toBe(BUILD_VARIANT_CONTRACT.preview);
        expect(() => getBuildVariantConfig('staging')).toThrow('Unknown APP_ENV variant');
        expect(() => assertVariantOtaTarget('preview', 'preview', '23')).not.toThrow();
        expect(() => assertVariantOtaTarget('preview', 'production', '24')).toThrow('OTA target mismatch');

        const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
        expect(appConfig).toContain('getBuildVariantConfig');
        expect(appConfig).toContain('const buildVariant = getBuildVariantConfig(variant);');
        expect(appConfig).toContain('runtimeVersion: otaRuntimeVersion');

        const otaSite = readFileSync(new URL('../../ota-server/site/index.html', import.meta.url), 'utf8');
        expect(otaSite).toContain("const PREFIX = 'meta/android/23/preview/';");
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
        expect(previewWorkflow).toContain('patches/fix-expo-camera-scanner-transitions.cjs');
        expect(previewWorkflow).toContain('scripts/postinstall.cjs');
        expect(previewWorkflow).toContain("github.head_ref != 'automation/sync-image-effects'");
        expect(productionWorkflow).not.toContain('github.event.inputs.channel');
        expect(productionWorkflow).toContain('--variant production --channel production');
        expect(productionWorkflow).toContain('patches/fix-expo-camera-scanner-transitions.cjs');
        expect(productionWorkflow).toContain('scripts/postinstall.cjs');
        expect(packageJson.scripts['ota:selfhost:preview']).toContain('--variant preview --channel preview');
        expect(packageJson.scripts['ota:selfhost']).toContain('--variant production --channel production');
    });

    it('runs the Expo Camera native patch contract in App CI', () => {
        const typecheckWorkflow = readFileSync(
            new URL('../../../../.github/workflows/typecheck.yml', import.meta.url),
            'utf8'
        );

        expect(typecheckWorkflow).toContain("'patches/fix-expo-camera-scanner-transitions.cjs'");
        expect(typecheckWorkflow).toContain("'scripts/postinstall.cjs'");
        expect(typecheckWorkflow).toContain('pnpm test:expo-camera-patch');
    });
});
