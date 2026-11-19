const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { classifyOtaImpact, onlyRemovedWorkspaceImporters } = require('./classify-ota-impact.cjs');
const source = 'packages/happy-app/';

test('Web implementations and public assets skip OTA without implying a native rebuild', () => {
  const result = classifyOtaImpact([source+'sources/components/Panel.web.tsx', source+'public/logo.png']);
  assert.equal(result.otaCompatible, false);
  assert.equal(result.reason, 'web-only');
  assert.deepEqual(result.native, []);
});

test('shared and mobile files retain OTA even alongside Web changes', () => {
  for (const file of ['sources/components/Panel.tsx', 'sources/hooks/usePanel.ts', 'sources/components/Panel.android.tsx', 'sources/assets/image.png']) {
    const result = classifyOtaImpact([source+file, source+'sources/components/Panel.web.tsx']);
    assert.equal(result.otaCompatible, true, file);
    assert.equal(result.reason, 'mobile-or-shared');
  }
});

test('native configuration, dependencies and lockfile retain the APK compatibility guard', () => {
  for (const file of ['pnpm-lock.yaml', 'scripts/postinstall.cjs', source+'package.json', source+'ota-runtime-versions.json', source+'android/app/build.gradle', source+'ios/Info.plist', source+'plugins/cert.js']) {
    const result = classifyOtaImpact([file, source+'sources/components/Panel.tsx']);
    assert.equal(result.otaCompatible, false, file);
    assert.equal(result.reason, 'native-sensitive');
  }
});

test('documentation, tests and tooling alone do not publish OTA', () => {
  const result = classifyOtaImpact([source+'CLAUDE.md', source+'sources/types.d.ts', source+'sources/panel.test.tsx', source+'e2e/fixture.ts', source+'sources/trash/demo.tsx', 'scripts/upload-web-assets.sh']);
  assert.equal(result.reason, 'no-runtime-change');
  assert.equal(result.otaCompatible, false);
});

test('manual dispatch remains an explicit publish operation', () => {
  assert.equal(classifyOtaImpact([], 'workflow_dispatch').otaCompatible, true);
});

test('real Git comparison emits workflow outputs and treats mobile-to-Web renames as mobile changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paws-ota-impact-'));
  const cli = join(__dirname, 'classify-ota-impact.cjs');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
    mkdirSync(join(directory, source, 'sources'), { recursive: true });
    const file = source+'sources/panel.web.tsx';
    writeFileSync(join(directory, file), 'export const panel = 1;');
    git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, file), 'export const panel = 2;'); git('add', '.'); git('commit', '-m', 'web');
    const run = (before, head, suffix) => spawnSync(process.execPath, [cli], { cwd: directory, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: before, HEAD_SHA: head,
      GITHUB_OUTPUT: join(directory, suffix+'.out'), GITHUB_STEP_SUMMARY: join(directory, suffix+'.md'),
    } });
    const web = run(base, git('rev-parse', 'HEAD'), 'web');
    assert.equal(web.status, 0, web.stderr);
    assert.match(readFileSync(join(directory, 'web.out'), 'utf8'), /ota_compatible=false\ndelivery_reason=web-only/);
    git('mv', file, source+'sources/panel.tsx'); git('commit', '-m', 'shared');
    const shared = git('rev-parse', 'HEAD');
    git('mv', source+'sources/panel.tsx', file); git('commit', '-m', 'move to web');
    const renamed = run(shared, git('rev-parse', 'HEAD'), 'rename');
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.equal(JSON.parse(renamed.stdout).otaCompatible, true);
    const uncertain = run('0'.repeat(40), git('rev-parse', 'HEAD'), 'bad');
    assert.notEqual(uncertain.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('only a deleted non-App workspace importer can bypass lockfile sensitivity', () => {
  const before = "lockfileVersion: '9.0'\n\nimporters:\n\n  packages/happy-app:\n    dependencies: {}\n\n  packages/retired:\n    devDependencies: {}\n\n  packages/other:\n    dependencies: {}\n\npackages:\n  native@1: {}\n";
  const after = before.replace('  packages/retired:\n    devDependencies: {}\n\n', '');
  assert.equal(onlyRemovedWorkspaceImporters(before, after, ['packages/retired/package.json']), true);
  assert.equal(onlyRemovedWorkspaceImporters(before, after, []), false);
  assert.equal(onlyRemovedWorkspaceImporters(before, after.replace('native@1', 'native@2'), ['packages/retired/package.json']), false);
  assert.equal(onlyRemovedWorkspaceImporters(before, after.replace('dependencies: {}', 'dependencies: {changed: 1}'), ['packages/retired/package.json']), false);
  assert.equal(onlyRemovedWorkspaceImporters(before, before.replace('  packages/happy-app:\n    dependencies: {}\n\n', ''), ['packages/happy-app/package.json']), false);
});

const retainedImporter = `  packages/happy-app:
    dependencies:
      keep:
        specifier: 1.0.0
        version: 1.0.0

`;
const retiredImporter = `  packages/retired:
    dependencies:
      orphan:
        specifier: 2.0.0
        version: 2.0.0

`;
const retainedPackages = '  keep@1.0.0:\n    resolution: {integrity: keep}\n\n  native@1.0.0:\n    resolution: {integrity: native}\n\n';
const prunedPackages = '  orphan@2.0.0:\n    resolution: {integrity: orphan}\n\n  leaf@3.0.0:\n    resolution: {integrity: leaf}\n\n';
const retainedSnapshots = '  keep@1.0.0:\n    dependencies:\n      native-alias: native@1.0.0\n\n  native@1.0.0: {}\n';
const prunedSnapshots = '\n  orphan@2.0.0:\n    dependencies:\n      leaf: 3.0.0\n\n  leaf@3.0.0: {}\n';
const lock = (importers, packages, snapshots) => `lockfileVersion: '9.0'\n\nimporters:\n\n${importers}\npackages:\n\n${packages}\nsnapshots:\n\n${snapshots}`;
const originalLock = lock(retainedImporter + retiredImporter, retainedPackages + prunedPackages, retainedSnapshots + prunedSnapshots);
const prunedLock = lock(retainedImporter, retainedPackages, retainedSnapshots);
const deletedWorkspace = ['packages/retired/package.json'];

test('retiring a non-App workspace may prune its unreachable dependency tree without changing retained records', () => {
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock, deletedWorkspace), true);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock, []), false);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock, ['packages/happy-app/package.json']), false);
});

test('lock pruning retains native guards for referenced packages, metadata, changed edges, and additions', () => {
  const missingNative = lock(retainedImporter, retainedPackages.replace(/  native@1\.0\.0:[\s\S]*/, ''), retainedSnapshots.replace('  native@1.0.0: {}\n', ''));
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, missingNative, deletedWorkspace), false);
  const missingMetadata = lock(retainedImporter, retainedPackages.replace(/  native@1\.0\.0:[\s\S]*/, ''), retainedSnapshots);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, missingMetadata, deletedWorkspace), false);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock.replace('integrity: native', 'integrity: changed'), deletedWorkspace), false);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock.replace('native-alias: native@1.0.0', 'native-alias: orphan@2.0.0'), deletedWorkspace), false);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock + '\n  added@1.0.0: {}\n', deletedWorkspace), false);
  assert.equal(onlyRemovedWorkspaceImporters(originalLock, prunedLock.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'"), deletedWorkspace), false);
});

test('unchanged missing peer contexts cannot conceal pruning of another record of that package version', () => {
  const reference = retainedImporter.replace('version: 1.0.0', 'version: 1.0.0(peer@9.0.0)');
  const original = lock(reference + retiredImporter, retainedPackages + prunedPackages, retainedSnapshots + prunedSnapshots);
  assert.equal(onlyRemovedWorkspaceImporters(original, lock(reference, retainedPackages, retainedSnapshots), deletedWorkspace), true);
  const missingKeep = lock(reference, retainedPackages.replace(/  keep@1\.0\.0:[\s\S]*?(?=  native@)/, ''), '  native@1.0.0: {}\n');
  assert.equal(onlyRemovedWorkspaceImporters(original, missingKeep, deletedWorkspace), false);
});

test('unknown lock reference protocols and surviving links to a deleted workspace stay native-sensitive', () => {
  for (const version of ['npm:keep@1.0.0', 'link:../retired']) {
    const importer = retainedImporter.replace('version: 1.0.0', `version: ${version}`);
    const before = lock(importer + retiredImporter, retainedPackages + prunedPackages, retainedSnapshots + prunedSnapshots);
    assert.equal(onlyRemovedWorkspaceImporters(before, lock(importer, retainedPackages, retainedSnapshots), deletedWorkspace), false);
  }
});
