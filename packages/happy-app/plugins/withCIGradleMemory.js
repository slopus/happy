const { withGradleProperties } = require('expo/config-plugins');

/**
 * Increases Gradle JVM memory for CI builds (GitHub Actions runners have limited RAM).
 * Only activates when CI=true to avoid affecting local development.
 */
function withCIGradleMemory(config) {
    if (process.env.CI !== 'true') return config;

    return withGradleProperties(config, (config) => {
        function setProperty(key, value) {
            const idx = config.modResults.findIndex(
                (item) => item.type === 'property' && item.key === key
            );
            if (idx >= 0) {
                config.modResults[idx].value = value;
            } else {
                config.modResults.push({ type: 'property', key, value });
            }
        }

        setProperty('org.gradle.jvmargs', '-Xmx4g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError');
        setProperty('org.gradle.workers.max', '2');

        return config;
    });
}

module.exports = withCIGradleMemory;
