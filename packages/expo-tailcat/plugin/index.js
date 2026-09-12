'use strict';

const { withInfoPlist, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = function withTailcat(config) {
  config = withInfoPlist(config, config => {
    const ats = config.modResults.NSAppTransportSecurity || {};
    config.modResults.NSAppTransportSecurity = {
      ...ats,
      NSAllowsLocalNetworking: true,
      NSExceptionDomains: {
        ...ats.NSExceptionDomains,
        '127.0.0.1': { NSExceptionAllowsInsecureHTTPLoads: true },
      },
    };
    config.modResults.NSLocalNetworkUsageDescription ||= 'Connect to your paired devices over Tailcat.';
    return config;
  });
  config = withAndroidManifest(config, config => {
    const app = config.modResults.manifest.application[0];
    const existing = app.$['android:networkSecurityConfig'];
    if (existing && existing !== '@xml/expo_tailcat_network_security') {
      throw new Error('expo-tailcat: an existing Android networkSecurityConfig must be merged manually; allow cleartext for 127.0.0.1 only.');
    }
    app.$['android:networkSecurityConfig'] = '@xml/expo_tailcat_network_security';
    return config;
  });
  return withDangerousMod(config, ['android', async config => {
    const dir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'expo_tailcat_network_security.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain>127.0.0.1</domain>
    <domain>localhost</domain>
  </domain-config>
  <debug-overrides><trust-anchors><certificates src="user" /></trust-anchors></debug-overrides>
</network-security-config>
`);
    return config;
  }]);
};