const { withAndroidManifest } = require('@expo/config-plugins');

const withCleartextTraffic = (config) => {
    return withAndroidManifest(config, (config) => {
        const application = config.modResults.manifest.application?.[0];
        if (application) {
            application.$['android:usesCleartextTraffic'] = 'true';
        }
        return config;
    });
};

module.exports = withCleartextTraffic;
