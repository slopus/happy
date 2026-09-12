const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadPlugin() {
  const mods = {};
  const writes = [];
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === 'expo/config-plugins') return {
      withInfoPlist: (config, mod) => { mods.ios = mod; return config; },
      withAndroidManifest: (config, mod) => { mods.android = mod; return config; },
      withDangerousMod: (config, [, mod]) => { mods.files = mod; return config; },
      withGradleProperties: (config, mod) => { mods.gradle = mod; return config; },
    };
    if (name === 'node:fs/promises') return { mkdir: async () => {}, writeFile: async (...args) => writes.push(args) };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/index.js'), 'utf8'), sandbox);
  sandbox.module.exports({});
  return { mods, writes };
}

test('iOS plugin preserves existing ATS policy and local-network explanation', () => {
  const { mods } = loadPlugin();
  const config = { modResults: { NSLocalNetworkUsageDescription: 'Existing explanation',
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSExceptionDomains: { 'example.com': { existing: true } } } } };
  mods.ios(config);
  assert.equal(config.modResults.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(config.modResults.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  assert.ok(config.modResults.NSAppTransportSecurity.NSExceptionDomains['example.com'].existing);
  assert.equal(config.modResults.NSLocalNetworkUsageDescription, 'Existing explanation');
});

test('Android refuses to overwrite another network security config', () => {
  const { mods } = loadPlugin();
  const config = { modResults: { manifest: { application: [{ $: { 'android:networkSecurityConfig': '@xml/custom' } }] } } };
  assert.throws(() => mods.android(config), /merged manually/);
});

test('Android cleartext exception is loopback-only and idempotent', async () => {
  const { mods, writes } = loadPlugin();
  const config = { modResults: { manifest: { application: [{ $: {} }] } } };
  mods.android(config); mods.android(config);
  assert.equal(config.modResults.manifest.application[0].$['android:networkSecurityConfig'], '@xml/expo_tailcat_network_security');
  await mods.files({ modRequest: { platformProjectRoot: '/test-project' } });
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /base-config cleartextTrafficPermitted="false"/);
  assert.match(writes[0][1], /<domain>127\.0\.0\.1<\/domain>/);
  assert.doesNotMatch(writes[0][1], /includeSubdomains|cleartextTrafficPermitted="true"\s*\/>/);
});

test('Android requires API 26 while preserving a higher app minimum', () => {
  const { mods } = loadPlugin();
  for (const minimum of [undefined, '24', '26', '30']) {
    const config = { modResults: minimum === undefined ? [] : [{ type: 'property', key: 'android.minSdkVersion', value: minimum }] };
    mods.gradle(config); mods.gradle(config);
    assert.equal(config.modResults.length, 1);
    assert.equal(config.modResults[0].value, minimum === '30' ? '30' : '26');
  }
});