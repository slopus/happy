const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Generates the network security config XML content based on environment.
 *
 * @param {boolean} allowCleartext - Whether to allow cleartext (HTTP) traffic
 * @returns {string} XML content for network_security_config.xml
 */
function generateNetworkSecurityConfig(allowCleartext) {
    return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="${allowCleartext}">
        <trust-anchors>
            <certificates src="system"/>
            <certificates src="user"/>
        </trust-anchors>
    </base-config>
</network-security-config>
`;
}

/**
 * Expo config plugin that configures Android network security settings.
 *
 * This plugin:
 * 1. Creates a network_security_config.xml file that trusts user-installed CA certificates
 * 2. Optionally enables cleartext (HTTP) traffic based on APP_ENV
 * 3. Adds the networkSecurityConfig attribute to the AndroidManifest.xml
 *
 * Environment-based cleartext behavior:
 * - development/preview: cleartext enabled (for local development servers)
 * - production: cleartext disabled (HTTPS only)
 *
 * User CA certificates are always trusted to support mTLS with custom servers.
 */
const withNetworkSecurityConfig = (config) => {
    const variant = process.env.APP_ENV || 'development';
    const allowCleartext = variant !== 'production';

    // Step 1: Create the network_security_config.xml file
    config = withDangerousMod(config, [
        'android',
        async (config) => {
            const resXmlDir = path.join(
                config.modRequest.platformProjectRoot,
                'app',
                'src',
                'main',
                'res',
                'xml'
            );

            // Ensure the xml directory exists
            if (!fs.existsSync(resXmlDir)) {
                fs.mkdirSync(resXmlDir, { recursive: true });
            }

            const configPath = path.join(resXmlDir, 'network_security_config.xml');
            const xmlContent = generateNetworkSecurityConfig(allowCleartext);

            fs.writeFileSync(configPath, xmlContent, 'utf-8');

            console.log('✅ Network security config plugin applied');
            console.log(`   Cleartext traffic: ${allowCleartext ? 'ENABLED' : 'DISABLED'} (APP_ENV=${variant})`);
            console.log('   User CA certificates: TRUSTED');

            return config;
        },
    ]);

    // Step 2: Add networkSecurityConfig attribute to AndroidManifest.xml
    config = withAndroidManifest(config, (config) => {
        const manifest = config.modResults.manifest;
        const application = manifest.application?.[0];

        if (application) {
            application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
        }

        return config;
    });

    return config;
};

module.exports = withNetworkSecurityConfig;
