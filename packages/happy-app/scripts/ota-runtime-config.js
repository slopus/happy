const OTA_RUNTIME_VERSION_BY_VARIANT = Object.freeze(require('../ota-runtime-versions.json'));

function defaultRuntimeVersion(channel) {
    return channel === 'production'
        ? OTA_RUNTIME_VERSION_BY_VARIANT.production
        : OTA_RUNTIME_VERSION_BY_VARIANT.preview;
}

module.exports = {
    OTA_RUNTIME_VERSION_BY_VARIANT,
    defaultRuntimeVersion,
};
