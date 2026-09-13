const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function releaseInput(version, channel) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const beta = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
  assert(channel === 'latest' || channel === 'beta', 'Channel must be latest or beta');
  assert(typeof version === 'string' && version.length < 100, 'A release version is required');
  assert((channel === 'beta' ? beta : stable).test(version),
    `Version must be ${channel === 'beta' ? 'X.Y.Z-beta.N' : 'X.Y.Z'} for ${channel}`);
  return { version, channel, tag: `cli-${version}`, tarball: `happy-${version}.tgz` };
}

function checkManifest(manifest, version) {
  assert.equal(manifest.name, 'happy');
  assert.equal(manifest.version, version);
  const repository = typeof manifest.repository === 'string'
    ? manifest.repository : manifest.repository?.url;
  assert.equal(repository?.replace(/^git\+/, '').replace(/\.git$/, ''),
    'https://github.com/slopus/happy', 'Provenance must identify slopus/happy');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert(!manifest[field]?.['@slopus/happy-wire'], 'happy-wire must be bundled, not a runtime dependency');
    for (const spec of Object.values(manifest[field] || {})) {
      assert(!/^(workspace|file|link):/.test(spec), `Unresolved runtime dependency: ${spec}`);
    }
  }
}

function checkVersionOutput(output, version) {
  assert(output.split(/\r?\n/).includes(`happy version: ${version}`),
    `The installed CLI did not report happy version: ${version}\n${output}`);
}

function checkPackage(root, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  checkManifest(manifest, version);
  for (const bin of ['happy', 'happy-mcp']) {
    assert.equal(manifest.bin?.[bin]?.replace(/^\.\//, ''), `bin/${bin}.mjs`);
    assert(fs.existsSync(path.join(root, manifest.bin[bin])), `Missing ${bin} entrypoint`);
  }
  for (const file of ['dist/index.mjs', 'dist/index.cjs', 'dist/lib.mjs', 'dist/lib.cjs']) {
    assert(fs.existsSync(path.join(root, file)), `Missing ${file}`);
  }
  const wireImport = /(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)['"]@slopus\/happy-wire(?:\/[^'"]*)?['"]/;
  for (const file of fs.readdirSync(path.join(root, 'dist'), { recursive: true })) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    assert(!wireImport.test(fs.readFileSync(path.join(root, 'dist', file), 'utf8')),
      `Runtime happy-wire import in ${file}`);
  }
  for (const tool of ['ripgrep', 'difftastic']) {
    for (const platform of ['arm64-darwin', 'x64-darwin', 'arm64-linux', 'x64-linux', 'arm64-win32', 'x64-win32']) {
      assert(fs.existsSync(path.join(root, 'tools', 'archives', `${tool}-${platform}.tar.gz`)),
        `Missing ${tool} archive for ${platform}`);
    }
  }
  for (const directory of ['tools/server', 'tools/webapp']) {
    assert(!fs.existsSync(path.join(root, directory)), `${directory} belongs in happy-server-self-host`);
  }
}

function smoke(prefix, version) {
  const root = path.join(prefix, 'node_modules', 'happy');
  checkPackage(root, version);
  for (const args of [['--version'], ['--help'], ['daemon', 'status']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/happy.mjs'), ...args], {
      cwd: prefix,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HAPPY_HOME_DIR: path.join(prefix, 'happy-home'),
        HAPPY_BOOT_AGENT: '0',
        HAPPY_EXPERIMENTAL: '0',
      },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `happy ${args.join(' ')} failed`);
    if (args[0] === '--version') checkVersionOutput(result.stdout, version);
  }
}

async function main() {
  const release = releaseInput(process.env.RELEASE_VERSION, process.env.RELEASE_CHANNEL);
  const [command, target] = process.argv.slice(2);
  if (command === 'validate') {
    console.log(`Validated happy@${release.version} for ${release.channel}`);
  } else if (command === 'prepare') {
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    manifest.version = release.version;
    checkManifest(manifest, release.version);
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (command === 'check-package') {
    checkPackage(target, release.version);
  } else if (command === 'smoke') {
    smoke(target, release.version);
  } else {
    throw new Error(`Unknown release command: ${command}`);
  }
}

module.exports = { releaseInput, checkManifest, checkVersionOutput, checkPackage };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });