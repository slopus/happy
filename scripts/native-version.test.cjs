const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseVersion, checkVersion, taggedVersions, nextVersion, setVersion, currentVersion } = require('./native-version.cjs');

const november = new Date('2026-11-07T12:00:00Z');

test('versions are YYYY.M.C with an unpadded month and a counter from 1', () => {
  assert.deepEqual(parseVersion('2026.11.1'), { year: 2026, month: 11, counter: 1 });
  assert.deepEqual(parseVersion('2026.9.12'), { year: 2026, month: 9, counter: 12 });
  for (const version of ['2.0.0', '2026.09.1', '2026.13.1', '2026.0.1', '2026.11.0', '2026.11.01',
    '2026.11', '2026.11.1.1', 'v2026.11.1', '2026.11.1-beta', '2026.11.1\n', '0999.1.1']) {
    assert.equal(parseVersion(version), null, version);
    assert.throws(() => checkVersion(version), /CalVer/, version);
  }
});

test('only the platform\'s CalVer release tags count', () => {
  const tags = ['native-ios-2.0.0-build155', 'native-android-2.0.0-build150', 'native-ios-2026.11.2-build160',
    'native-android-2026.11.5-build170', 'native-ios-2026.11.3', 'cli-2026.11.9', 'native-ios-2026.11.x-build1',
    'native-ios-preview-2026.11.4-build161', 'desktop-2026.11.6', 'native-ios-2026.11.7-preview.1-build162'];
  assert.deepEqual(taggedVersions('ios', tags), ['2026.11.2']);
  assert.deepEqual(taggedVersions('android', tags), ['2026.11.5']);
});

test('the first release of a month is C = 1; legacy tags and other platforms do not count', () => {
  // Uploads leave no tag: until a version is released, next keeps naming it.
  assert.equal(nextVersion('ios', [], november), '2026.11.1');
  assert.equal(nextVersion('ios', ['native-ios-2.0.0-build155', 'native-android-2026.11.4-build170'], november), '2026.11.1');
  assert.equal(nextVersion('android', ['native-android-2.0.0-build150'], new Date('2027-01-01T00:00:00Z')), '2027.1.1');
});

test('the counter follows the highest release tag this month and resets the next month', () => {
  const tags = ['native-ios-2026.10.7-build158', 'native-ios-2026.11.1-build159', 'native-ios-2026.11.2-build160',
    'native-ios-2026.11.2-build161', 'native-ios-2026.11.10-build170', 'native-ios-2025.11.30-build100'];
  assert.equal(nextVersion('ios', tags, november), '2026.11.11');
  // Two tags of one version count once.
  assert.equal(nextVersion('ios', ['native-ios-2026.11.2-build160', 'native-ios-2026.11.2-build161'], november), '2026.11.3');
  assert.equal(nextVersion('ios', tags, new Date('2026-12-01T00:00:00Z')), '2026.12.1');
});

test('the month is UTC', () => {
  const tags = ['native-android-2026.11.3-build171'];
  // 23:30 on 30 November in UTC-5 is already December in UTC.
  assert.equal(nextVersion('android', tags, new Date('2026-11-30T23:30:00-05:00')), '2026.12.1');
  assert.equal(nextVersion('android', tags, new Date('2026-11-30T23:30:00Z')), '2026.11.4');
});

test('a tag later than now stops rather than going backwards', () => {
  assert.throws(() => nextVersion('ios', ['native-ios-2026.12.1-build170'], november), /check the clock/);
  assert.throws(() => nextVersion('web', [], november), /ios or android/);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-version-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('packages/happy-ios/project.yml', 'settings:\n  base:\n    MARKETING_VERSION: "2.0.0"\n    CURRENT_PROJECT_VERSION: "1"\n');
  write('packages/happy-ios/AppClip/project.yml', 'settings:\n  base:\n    MARKETING_VERSION: "2.0.0"\n');
  for (const variant of ['Development', 'Preview', 'Production']) {
    write(`packages/happy-ios/App/Info-${variant}.plist`,
      '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>2.0.0</string>\n\t<key>CFBundleVersion</key>\n\t<string>157</string>\n</dict>\n');
  }
  write('packages/happy-android/app/build.gradle.kts',
    'val defaultVersionName = "1.8.0"\nval versionNameValue = env ?: defaultVersionName\n        versionCode = versionCodeValue ?: 1\n');
  return root;
}

test('set writes the iOS version everywhere MARKETING_VERSION is repeated, and nothing else', () => {
  const root = fixture();
  setVersion('ios', '2026.11.1', root);
  const read = file => fs.readFileSync(path.join(root, 'packages/happy-ios', file), 'utf8');
  assert.equal(read('project.yml'), 'settings:\n  base:\n    MARKETING_VERSION: "2026.11.1"\n    CURRENT_PROJECT_VERSION: "1"\n');
  assert.equal(read('AppClip/project.yml'), 'settings:\n  base:\n    MARKETING_VERSION: "2026.11.1"\n');
  for (const variant of ['Development', 'Preview', 'Production']) {
    assert.match(read(`App/Info-${variant}.plist`), /<string>2026\.11\.1<\/string>\n\t<key>CFBundleVersion<\/key>\n\t<string>157<\/string>/);
  }
  assert.equal(currentVersion('ios', root), '2026.11.1');
  assert.equal(currentVersion('android', root), '1.8.0');
});

test('set writes the Android default versionName', () => {
  const root = fixture();
  setVersion('android', '2026.11.2', root);
  assert.equal(fs.readFileSync(path.join(root, 'packages/happy-android/app/build.gradle.kts'), 'utf8'),
    'val defaultVersionName = "2026.11.2"\nval versionNameValue = env ?: defaultVersionName\n        versionCode = versionCodeValue ?: 1\n');
  assert.equal(currentVersion('android', root), '2026.11.2');
});

test('set refuses a bad version and a file it cannot find the version in', () => {
  const root = fixture();
  assert.throws(() => setVersion('ios', '2026.11', root), /CalVer/);
  fs.writeFileSync(path.join(root, 'packages/happy-ios/AppClip/project.yml'), 'settings: {}\n');
  assert.throws(() => setVersion('ios', '2026.11.1', root), /AppClip\/project\.yml: expected 1 version setting, found 0/);
});

test('the checked-in versions are CalVer and every iOS copy agrees', () => {
  const root = path.resolve(__dirname, '..');
  for (const platform of ['ios', 'android']) checkVersion(currentVersion(platform, root));
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'native-version-'));
  // Writing the current version over itself changes nothing only if every copy already says it.
  const files = ['project.yml', 'AppClip/project.yml', 'App/Info-Development.plist', 'App/Info-Preview.plist', 'App/Info-Production.plist']
    .map(file => `packages/happy-ios/${file}`);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(copy, file));
  }
  setVersion('ios', currentVersion('ios', root), copy);
  for (const file of files) assert.equal(fs.readFileSync(path.join(copy, file), 'utf8'), fs.readFileSync(path.join(root, file), 'utf8'), file);
});

test('a version released in a later month does not hold back that month', () => {
  // 2026.11.1 was uploaded in November and released on 2 December.
  assert.equal(nextVersion('ios', ['native-ios-2026.11.1-build158'], new Date('2026-12-02T10:00:00Z')), '2026.12.1');
});
