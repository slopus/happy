const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin that adds an Android Foreground Service for background audio recording.
 *
 * This plugin:
 * 1. Adds FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, and WAKE_LOCK permissions
 * 2. Registers a ForegroundService in the AndroidManifest
 * 3. Copies the native Kotlin source files into the generated android project
 */
const withForegroundService = (config) => {
    // Step 1: Modify AndroidManifest.xml
    config = withAndroidManifest(config, (manifestConfig) => {
        const manifest = manifestConfig.modResults.manifest;

        // Add permissions
        if (!manifest['uses-permission']) {
            manifest['uses-permission'] = [];
        }

        const requiredPermissions = [
            'android.permission.FOREGROUND_SERVICE',
            'android.permission.FOREGROUND_SERVICE_MICROPHONE',
            'android.permission.WAKE_LOCK',
        ];

        for (const perm of requiredPermissions) {
            const exists = manifest['uses-permission'].find(
                (p) => p.$?.['android:name'] === perm
            );
            if (!exists) {
                manifest['uses-permission'].push({
                    $: { 'android:name': perm },
                });
            }
        }

        // Add service declaration to the application element
        const application = manifest.application?.[0];
        if (application) {
            if (!application.service) {
                application.service = [];
            }

            const serviceName = '.foregroundservice.VoiceForegroundService';
            const exists = application.service.find(
                (s) => s.$?.['android:name'] === serviceName
            );
            if (!exists) {
                application.service.push({
                    $: {
                        'android:name': serviceName,
                        'android:foregroundServiceType': 'microphone',
                        'android:exported': 'false',
                    },
                });
            }
        }

        console.log('✅ Foreground service plugin: manifest updated');
        return manifestConfig;
    });

    // Step 2: Copy native Kotlin source files into the android project
    config = withDangerousMod(config, [
        'android',
        async (dangerousConfig) => {
            const projectRoot = dangerousConfig.modRequest.projectRoot;
            const packageName = dangerousConfig.android?.package || 'com.slopus.happy.dev';
            const packagePath = packageName.replace(/\./g, '/');

            const sourceDir = path.join(
                projectRoot,
                'plugins',
                'foreground-service-native'
            );
            const destDir = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'java',
                packagePath,
                'foregroundservice'
            );

            // Create destination directory
            fs.mkdirSync(destDir, { recursive: true });

            // Read each Kotlin file, replace package placeholder, and write
            const files = [
                'VoiceForegroundService.kt',
                'VoiceForegroundServiceModule.kt',
                'VoiceForegroundServicePackage.kt',
            ];

            for (const file of files) {
                const src = path.join(sourceDir, file);
                if (!fs.existsSync(src)) {
                    console.warn(`⚠️ Foreground service plugin: missing ${file}`);
                    continue;
                }
                let content = fs.readFileSync(src, 'utf8');
                content = content.replace(
                    /package __PACKAGE__\.foregroundservice/g,
                    `package ${packageName}.foregroundservice`
                );
                content = content.replace(/__PACKAGE__/g, packageName);
                fs.writeFileSync(path.join(destDir, file), content, 'utf8');
            }

            // Register the package in MainApplication by patching the generated file
            const mainAppPath = path.join(
                projectRoot,
                'android',
                'app',
                'src',
                'main',
                'java',
                packagePath,
                'MainApplication.kt'
            );

            if (fs.existsSync(mainAppPath)) {
                let mainApp = fs.readFileSync(mainAppPath, 'utf8');
                const importLine = `import ${packageName}.foregroundservice.VoiceForegroundServicePackage`;
                const addLine = `packages.add(VoiceForegroundServicePackage())`;

                if (!mainApp.includes('VoiceForegroundServicePackage')) {
                    // Add import after the last import statement
                    mainApp = mainApp.replace(
                        /(import [^\n]+\n)(?!import)/,
                        `$1${importLine}\n`
                    );

                    // Add package registration in getPackages()
                    mainApp = mainApp.replace(
                        /(val packages = PackageList\(this\)\.packages)/,
                        `$1\n            ${addLine}`
                    );

                    fs.writeFileSync(mainAppPath, mainApp, 'utf8');
                }
            }

            console.log('✅ Foreground service plugin: native files copied');
            return dangerousConfig;
        },
    ]);

    return config;
};

module.exports = withForegroundService;
