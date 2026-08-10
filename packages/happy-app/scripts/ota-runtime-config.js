const OTA_RUNTIME_VERSION_BY_VARIANT = Object.freeze(require('../ota-runtime-versions.json'));

const BUILD_VARIANT_CONTRACT = Object.freeze({
    development: Object.freeze({
        appName: 'Paws (dev)',
        androidPackage: 'build.paws.dev',
        otaChannel: 'preview',
        runtimeVersion: OTA_RUNTIME_VERSION_BY_VARIANT.development,
    }),
    preview: Object.freeze({
        appName: 'Paws (preview)',
        androidPackage: 'build.paws.preview',
        otaChannel: 'preview',
        runtimeVersion: OTA_RUNTIME_VERSION_BY_VARIANT.preview,
    }),
    production: Object.freeze({
        appName: 'Paws',
        androidPackage: 'build.paws',
        otaChannel: 'production',
        runtimeVersion: OTA_RUNTIME_VERSION_BY_VARIANT.production,
    }),
});

function getBuildVariantConfig(variant) {
    const config = BUILD_VARIANT_CONTRACT[variant];
    if (!config) {
        throw new Error(`Unknown APP_ENV variant: ${variant}`);
    }
    return config;
}

function assertVariantOtaTarget(variant, channel, runtimeVersion) {
    const config = getBuildVariantConfig(variant);
    if (channel !== config.otaChannel || runtimeVersion !== config.runtimeVersion) {
        throw new Error(
            `OTA target mismatch for ${variant}: expected channel=${config.otaChannel} ` +
            `runtime=${config.runtimeVersion}, received channel=${channel} runtime=${runtimeVersion}`
        );
    }
}

function defaultRuntimeVersion(channel) {
    return channel === 'production'
        ? OTA_RUNTIME_VERSION_BY_VARIANT.production
        : OTA_RUNTIME_VERSION_BY_VARIANT.preview;
}

module.exports = {
    BUILD_VARIANT_CONTRACT,
    OTA_RUNTIME_VERSION_BY_VARIANT,
    assertVariantOtaTarget,
    defaultRuntimeVersion,
    getBuildVariantConfig,
};
