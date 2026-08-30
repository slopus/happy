import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { baselineEvidence } from './packaged-data-safety-e2e.mjs';
import {
  assertOwnedTaskRoot,
  compileNetworkGuard,
  fileSha256,
  restoreSnapshot,
  runNetworkGuardControls,
  selectMigrationPrefix,
} from './packaged-data-safety.mjs';

test('baseline assertion is optional for CI and exact when explicitly pinned', () => {
  const previous = process.env.HAPPY_DATA_SAFETY_BASELINE_REF;
  try {
    delete process.env.HAPPY_DATA_SAFETY_BASELINE_REF;
    const currentCheckout = baselineEvidence();
    assert.equal(currentCheckout.expectedRef, null);
    assert.equal(currentCheckout.exactMatch, null);

    process.env.HAPPY_DATA_SAFETY_BASELINE_REF = 'HEAD';
    const pinned = baselineEvidence();
    assert.equal(pinned.expectedRef, 'HEAD');
    assert.equal(pinned.expectedCommit, pinned.head);
    assert.equal(pinned.exactMatch, true);

    process.env.HAPPY_DATA_SAFETY_BASELINE_REF = 'refs/heads/self-host-data-safety-missing-ref';
    assert.throws(() => baselineEvidence(), /git-expected-baseline failed/);
  } finally {
    if (previous === undefined) delete process.env.HAPPY_DATA_SAFETY_BASELINE_REF;
    else process.env.HAPPY_DATA_SAFETY_BASELINE_REF = previous;
  }
});

test('cleanup accepts only a dedicated self-host data-safety temp root', () => {
  const owned = mkdtempSync(join(tmpdir(), 'happy-self-host-data-safety-'));

  try {
    assert.doesNotThrow(() => assertOwnedTaskRoot(owned));
    assert.throws(() => assertOwnedTaskRoot(tmpdir()), /refusing unsafe task root/i);
    assert.throws(() => assertOwnedTaskRoot(process.cwd()), /refusing unsafe task root/i);
    assert.throws(() => assertOwnedTaskRoot('/'), /refusing unsafe task root/i);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

test('network guard catches direct IP and DNS controls but allows loopback', () => {
  const taskRoot = mkdtempSync(join(tmpdir(), 'happy-self-host-data-safety-'));
  try {
    const guard = compileNetworkGuard(taskRoot);
    const controls = runNetworkGuardControls({ taskRoot, guard });
    assert.match(controls.log, /operation=connect target=1\.1\.1\.1:443/);
    assert.match(controls.log, /operation=dns target=api\.cluster-fluster\.com/);
    assert.equal(controls.loopbackExitCode, 0);
  } finally {
    rmSync(taskRoot, { recursive: true, force: true });
  }
});

test('old migration state is a pinned checked-in prefix with pending migrations', () => {
  const cutoff = '20260407053500_add_voice_conversation';
  const selection = selectMigrationPrefix([
    '20250922000310_add_user_kv',
    cutoff,
    '20260611120000_add_projects',
  ], cutoff);

  assert.deepEqual(selection.oldMigrations, [
    '20250922000310_add_user_kv',
    cutoff,
  ]);
  assert.deepEqual(selection.pendingMigrations, ['20260611120000_add_projects']);
  assert.throws(() => selectMigrationPrefix(['20260611120000_add_projects'], cutoff), /cutoff is missing/i);
  assert.throws(() => selectMigrationPrefix([cutoff], cutoff), /leave at least one migration pending/i);
});

test('restore validates a complete snapshot before promoting it', () => {
  const taskRoot = mkdtempSync(join(tmpdir(), 'happy-self-host-data-safety-'));
  const source = join(taskRoot, 'source-home');
  const target = join(taskRoot, 'restored-home');
  const validArchive = join(taskRoot, 'valid.tar');
  const incompleteArchive = join(taskRoot, 'incomplete.tar');

  try {
    mkdirSync(join(source, 'server-data', 'pglite'), { recursive: true });
    mkdirSync(join(source, 'server-data', 'files'), { recursive: true });
    writeFileSync(join(source, 'settings.json'), '{"serverUrl":"http://127.0.0.1:3005"}\n');
    writeFileSync(join(source, 'server-data', 'master-secret'), 'secret', { mode: 0o600 });
    writeFileSync(join(source, 'server-data', 'pglite', 'marker'), 'database');
    writeFileSync(join(source, 'server-data', 'files', 'upload'), 'attachment');

    const packed = spawnSync('tar', ['-cf', validArchive, '-C', source, '.'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const incomplete = spawnSync(
      'tar',
      ['-cf', incompleteArchive, '-C', source, 'settings.json', 'server-data/pglite'],
      { encoding: 'utf8' },
    );
    assert.equal(incomplete.status, 0, incomplete.stderr);

    const expectedHashes = new Map([
      ['settings.json', fileSha256(join(source, 'settings.json'))],
      ['server-data/master-secret', fileSha256(join(source, 'server-data', 'master-secret'))],
      ['server-data/pglite/marker', fileSha256(join(source, 'server-data', 'pglite', 'marker'))],
      ['server-data/files/upload', fileSha256(join(source, 'server-data', 'files', 'upload'))],
    ]);

    mkdirSync(target);
    assert.throws(
      () => restoreSnapshot({ taskRoot, archive: incompleteArchive, target, expectedHashes }),
      /snapshot is incomplete/i,
    );
    assert.deepEqual(readdirSync(target), []);

    restoreSnapshot({ taskRoot, archive: validArchive, target, expectedHashes });
    assert.equal(readFileSync(join(target, 'server-data', 'files', 'upload'), 'utf8'), 'attachment');
  } finally {
    rmSync(taskRoot, { recursive: true, force: true });
  }
});
