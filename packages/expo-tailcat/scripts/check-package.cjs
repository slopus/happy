const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const moduleConfig = require('../expo-module.config.json');
assert.equal(pkg.name, 'expo-tailcat');
assert.ok(!pkg.private);
assert.deepEqual(moduleConfig.platforms, ['apple', 'android']);
for (const file of ['src/index.js', 'src/index.d.ts', 'app.plugin.js', 'ios/ExpoTailcat.podspec',
  'ios/ExpoTailcatModule.swift', 'android/build.gradle', 'android/src/main/AndroidManifest.xml']) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing ${file}`);
}
assert.ok(!pkg.scripts.postinstall, 'Consumers must not compile or download native code during install');
if (process.argv.includes('--artifacts')) {
  for (const file of ['ios/Frameworks/Tailcat.xcframework/Info.plist', 'android/libs/ExpoTailcat.aar', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `Cannot pack: missing ${file}. Build both platforms and generate license notices first.`);
  }
}
console.log('expo-tailcat package checks passed');