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
                '  iosRuntimeVersion: config.ios.runtimeVersion,',
                '  expoProjectId: config.extra.eas.projectId,',
                '  expoOwner: config.owner,',
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
        runtimeVersion: '24',
        iosRuntimeVersion: '23',
        expoProjectId: '16941d72-39af-4e7e-8b91-9b0c11c46a56',
        expoOwner: 'wangjs-jacky',
    },
    preview: {
        name: 'Paws (preview)',
        androidPackage: 'build.paws.preview',
        otaChannel: 'preview',
        runtimeVersion: '24',
        iosRuntimeVersion: '23',
        expoProjectId: '16941d72-39af-4e7e-8b91-9b0c11c46a56',
        expoOwner: 'wangjs-jacky',
    },
    production: {
        name: 'Paws',
        androidPackage: 'build.paws',
        otaChannel: 'production',
        runtimeVersion: '25',
        iosRuntimeVersion: '24',
        expoProjectId: '16941d72-39af-4e7e-8b91-9b0c11c46a56',
        expoOwner: 'wangjs-jacky',
    },
} as const;

describe('OTA native runtime isolation', () => {
    it('isolates the Android variants after the Firebase native configuration change', () => {
        const {
            BUILD_VARIANT_CONTRACT,
            IOS_OTA_RUNTIME_VERSION_BY_VARIANT,
            OTA_RUNTIME_VERSION_BY_VARIANT,
            assertVariantOtaTarget,
            defaultRuntimeVersion,
            getBuildVariantConfig,
            getIosRuntimeVersion,
        } = require('../../scripts/ota-runtime-config.js');

        expect(OTA_RUNTIME_VERSION_BY_VARIANT).toEqual({
            development: '24',
            preview: '24',
            production: '25',
        });
        expect(IOS_OTA_RUNTIME_VERSION_BY_VARIANT).toEqual({
            development: '23',
            preview: '23',
            production: '24',
        });
        expect(defaultRuntimeVersion('preview')).toBe('24');
        expect(defaultRuntimeVersion('production')).toBe('25');
        expect(defaultRuntimeVersion('preview', 'ios')).toBe('23');
        expect(defaultRuntimeVersion('production', 'ios')).toBe('24');
        expect(getIosRuntimeVersion('production')).toBe('24');
        expect(BUILD_VARIANT_CONTRACT).toEqual({
            development: {
                appName: 'Paws (dev)',
                androidPackage: 'build.paws.dev',
                otaChannel: 'preview',
                runtimeVersion: '24',
            },
            preview: {
                appName: 'Paws (preview)',
                androidPackage: 'build.paws.preview',
                otaChannel: 'preview',
                runtimeVersion: '24',
            },
            production: {
                appName: 'Paws',
                androidPackage: 'build.paws',
                otaChannel: 'production',
                runtimeVersion: '25',
            },
        });
        expect(getBuildVariantConfig('preview')).toBe(BUILD_VARIANT_CONTRACT.preview);
        expect(() => getBuildVariantConfig('staging')).toThrow('Unknown APP_ENV variant');
        expect(() => assertVariantOtaTarget('preview', 'preview', '24')).not.toThrow();
        expect(() => assertVariantOtaTarget('preview', 'production', '25')).toThrow('OTA target mismatch');
        expect(() => assertVariantOtaTarget('production', 'production', '24', 'ios')).not.toThrow();
        expect(() => assertVariantOtaTarget('production', 'production', '25', 'ios')).toThrow('OTA target mismatch');

        const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
        expect(appConfig).toContain('getBuildVariantConfig');
        expect(appConfig).toContain('const buildVariant = getBuildVariantConfig(variant);');
        expect(appConfig).toContain('runtimeVersion: otaRuntimeVersion');

        const otaSite = readFileSync(new URL('../../ota-server/site/index.html', import.meta.url), 'utf8');
        expect(otaSite).toContain("const PREFIX = 'meta/android/24/preview/';");
    });

    it.each([
        ['development', BUILD_VARIANT_CONTRACT_EXPECTED.development],
        ['preview', BUILD_VARIANT_CONTRACT_EXPECTED.preview],
        ['production', BUILD_VARIANT_CONTRACT_EXPECTED.production],
    ])('renders the %s package/channel/runtime contract in Expo config', (variant, expected) => {
        expect(loadExpoVariant(variant)).toEqual(expected);
    });

    it('matches Paws Expo and Firebase push credentials across Android variants', () => {
        const expoProject = JSON.parse(readFileSync(new URL('../../expo-project.json', import.meta.url), 'utf8'));
        const firebaseConfig = JSON.parse(readFileSync(new URL('../../google-services.json', import.meta.url), 'utf8'));
        const pushRegistration = readFileSync(new URL('../sync/pushRegistration.ts', import.meta.url), 'utf8');

        expect(expoProject).toEqual({
            projectId: '16941d72-39af-4e7e-8b91-9b0c11c46a56',
            owner: 'wangjs-jacky',
        });
        expect(pushRegistration).toContain('const BUNDLED_EXPO_PROJECT_ID = expoProject.projectId');
        expect(firebaseConfig.project_info).toMatchObject({
            project_id: 'paws-502e2',
            project_number: '728670122353',
        });
        expect(firebaseConfig.client.map((client: {
            client_info: { android_client_info: { package_name: string } };
        }) => client.client_info.android_client_info.package_name).sort()).toEqual(
            Object.values(BUILD_VARIANT_CONTRACT_EXPECTED).map(({ androidPackage }) => androidPackage).sort()
        );
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
        for (const workflow of [previewWorkflow, productionWorkflow]) {
            expect(workflow).toContain('packages/happy-app/expo-project.json|\\');
            expect(workflow).toContain('packages/happy-app/google-services.json|\\');
            expect(workflow).toContain('packages/happy-app/ota-ios-runtime-versions.json|\\');
        }
        expect(previewWorkflow).toContain('patches/fix-expo-camera-scanner-transitions.cjs');
        expect(previewWorkflow).toContain('scripts/postinstall.cjs');
        expect(previewWorkflow).toContain("'!packages/happy-app/scripts/**'");
        expect(previewWorkflow).toContain("github.head_ref != 'automation/sync-image-effects'");
        expect(productionWorkflow).not.toContain('github.event.inputs.channel');
        expect(productionWorkflow).toContain('--variant production --channel production');
        expect(productionWorkflow).toContain('patches/fix-expo-camera-scanner-transitions.cjs');
        expect(productionWorkflow).toContain('scripts/postinstall.cjs');
        expect(productionWorkflow).toContain("'!packages/happy-app/scripts/**'");
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
