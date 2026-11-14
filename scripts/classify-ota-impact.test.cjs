const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { classifyOtaImpact } = require('./classify-ota-impact.cjs');
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
