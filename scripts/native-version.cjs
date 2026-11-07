// Native app versions (happy-ios, happy-android) are CalVer YYYY.M.C: the
// UTC year and month, then a counter that starts at 1 each month. Every
// variant (development, preview, production) carries the same version; a
// preview upload differs only by build number. The counter moves only when
// a production version ships, which the release flow records with a tag
// native-<platform>-<version>-build<N> on production uploads alone. So the
// next version is the highest counter this month's production tags carry,
// plus one, else 1. Each platform counts on its own; tags of other schemes
// (2.0.0) don't count. Build numbers are not versions and aren't touched.
//
//   node scripts/native-version.cjs next <ios|android> [--offline]
//   node scripts/native-version.cjs check <ios|android> [--offline]
//   node scripts/native-version.cjs set <ios|android> [version] [--offline]
//   node scripts/native-version.cjs current <ios|android>
//
// `next` prints the version the upcoming release takes. `check` fails unless
// the checked-in version is that one. `set` writes it (or the version given)
// everywhere the platform keeps it. `current` prints the checked-in version.
// Tags are read from origin and the local repository; --offline reads only
// the local ones.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLATFORMS = ['ios', 'android'];
const CALVER = /^([1-9]\d{3})\.([1-9]|1[0-2])\.([1-9]\d*)$/;
const ROOT = path.resolve(__dirname, '..');

function platformOf(value) {
  if (!PLATFORMS.includes(value)) throw new Error(`Platform must be ios or android, got '${value}'`);
  return value;
}

function parseVersion(version) {
  const match = CALVER.exec(version);
  return match && { year: Number(match[1]), month: Number(match[2]), counter: Number(match[3]) };
}

function checkVersion(version) {
  if (!parseVersion(version)) throw new Error(`Version must be CalVer YYYY.M.C (e.g. 2026.11.1), got '${version}'`);
  return version;
}

/** The CalVer versions a platform's production release tags carry. */
function taggedVersions(platform, tags) {
  const pattern = new RegExp(`^native-${platform}-(\\d[^-]*)-build\\d+$`);
  return tags.map(tag => pattern.exec(tag)?.[1]).filter(version => version && parseVersion(version));
}

/** The version the upcoming release of a platform takes, given its tags and the time. */
function nextVersion(platform, tags, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  let counter = 0;
  for (const version of taggedVersions(platformOf(platform), tags)) {
    const tagged = parseVersion(version);
    if (tagged.year * 12 + tagged.month > year * 12 + month) {
      throw new Error(`Tag version ${version} is later than ${year}.${month}: check the clock`);
    }
    if (tagged.year === year && tagged.month === month) counter = Math.max(counter, tagged.counter);
  }
  return `${year}.${month}.${counter + 1}`;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function readTags(platform, { offline = false } = {}) {
  const pattern = `native-${platform}-*`;
  const tags = git(['tag', '--list', pattern]).split('\n');
  if (!offline) {
    for (const line of git(['ls-remote', '--tags', '--refs', 'origin', `refs/tags/${pattern}`]).split('\n')) {
      tags.push(line.split('\trefs/tags/')[1]);
    }
  }
  return [...new Set(tags.filter(Boolean))];
}

// Every place a platform keeps its version: [file, pattern whose groups are
// what precedes the version, the version and what follows it, how many times
// it appears].
// xtool doesn't expand $(MARKETING_VERSION), so iOS repeats it.
const FILES = {
  ios: [
    ['packages/happy-ios/project.yml', /^(\s*MARKETING_VERSION: ")([^"]*)(")$/gm, 1],
    ['packages/happy-ios/AppClip/project.yml', /^(\s*MARKETING_VERSION: ")([^"]*)(")$/gm, 1],
    ...['Development', 'Preview', 'Production'].map(variant => [
      `packages/happy-ios/App/Info-${variant}.plist`,
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]*)(<\/string>)/g, 1,
    ]),
  ],
  android: [
    ['packages/happy-android/app/build.gradle.kts', /^(val defaultVersionName = ")([^"]*)(")$/gm, 1],
  ],
};

function setVersion(platform, version, root = ROOT) {
  checkVersion(version);
  for (const [file, pattern, count] of FILES[platformOf(platform)]) {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, 'utf8');
    const found = text.match(pattern)?.length ?? 0;
    if (found !== count) throw new Error(`${file}: expected ${count} version setting, found ${found}`);
    fs.writeFileSync(target, text.replace(pattern, (_, before, _old, after) => `${before}${version}${after}`));
  }
}

function currentVersion(platform, root = ROOT) {
  const [file, pattern] = FILES[platformOf(platform)][0];
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
  if (!match) throw new Error(`${file}: no version setting`);
  return match[2];
}

function main(argv) {
  const offline = argv.includes('--offline');
  const [command, platform, version] = argv.filter(arg => arg !== '--offline');
  platformOf(platform);
  if (command === 'next') {
    console.log(nextVersion(platform, readTags(platform, { offline })));
  } else if (command === 'check') {
    const next = nextVersion(platform, readTags(platform, { offline }));
    const current = currentVersion(platform);
    if (current !== next) {
      throw new Error(`${platform} is ${current}; the upcoming release is ${next}: run \`node scripts/native-version.cjs set ${platform}\` and land it on main`);
    }
    console.log(current);
  } else if (command === 'set') {
    const chosen = version ?? nextVersion(platform, readTags(platform, { offline }));
    setVersion(platform, chosen);
    console.log(chosen);
  } else if (command === 'current') {
    console.log(currentVersion(platform));
  } else {
    throw new Error(`Usage: native-version.cjs next|check|set|current ios|android [version] [--offline]`);
  }
}

module.exports = { parseVersion, checkVersion, taggedVersions, nextVersion, setVersion, currentVersion };
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
