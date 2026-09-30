const OTA_RUNTIME_VERSION_BY_VARIANT = Object.freeze(require('../ota-runtime-versions.json'));
const IOS_OTA_RUNTIME_VERSION_BY_VARIANT = Object.freeze(require('../ota-ios-runtime-versions.json'));

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

function runtimeVersionsForPlatform(platform) {
    if (platform === 'android') return OTA_RUNTIME_VERSION_BY_VARIANT;
    if (platform === 'ios') return IOS_OTA_RUNTIME_VERSION_BY_VARIANT;
    throw new Error(`Unknown OTA platform: ${platform}`);
}

function getIosRuntimeVersion(variant) {
    getBuildVariantConfig(variant);
    return IOS_OTA_RUNTIME_VERSION_BY_VARIANT[variant];
}

function assertVariantOtaTarget(variant, channel, runtimeVersion, platform = 'android') {
    const config = getBuildVariantConfig(variant);
    const expectedRuntimeVersion = runtimeVersionsForPlatform(platform)[variant];
    if (channel !== config.otaChannel || runtimeVersion !== expectedRuntimeVersion) {
        throw new Error(
            `OTA target mismatch for ${variant}: expected channel=${config.otaChannel} ` +
            `runtime=${expectedRuntimeVersion}, received channel=${channel} runtime=${runtimeVersion}`
        );
    }
}

function defaultRuntimeVersion(channel, platform = 'android') {
    const versions = runtimeVersionsForPlatform(platform);
    return channel === 'production'
        ? versions.production
        : versions.preview;
}

module.exports = {
    BUILD_VARIANT_CONTRACT,
    IOS_OTA_RUNTIME_VERSION_BY_VARIANT,
    OTA_RUNTIME_VERSION_BY_VARIANT,
    assertVariantOtaTarget,
    defaultRuntimeVersion,
    getBuildVariantConfig,
    getIosRuntimeVersion,
};
