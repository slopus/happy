import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkpoint, withLock, readJSON } from './io.mjs';

test('阶段完成后恢复不重复执行，资料变化立即阻止复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-resume-'));
  try {
    const file = join(dir, 'source.mp4'), job = { bvid: 'BV1ttykzFERD', statePath: join(dir, 'state.json'), phases: {} };
    let executions = 0;
    const action = async () => { executions++; await writeFile(file, 'original-source'); };
    await checkpoint(job, 'source', [file], action);
    const resumed = await readJSON(job.statePath);
    await checkpoint(resumed, 'source', [file], action); assert.equal(executions, 1);
    await writeFile(file, 'different-source');
    await assert.rejects(checkpoint(resumed, 'source', [file], action), /产物已变化/);
    assert.equal(executions, 1);
  } finally { await rm(dir, { recursive: true }); }
});

test('未完成阶段没有成功标记，显式恢复才重执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-failure-'));
  try {
    const file = join(dir, 'cards.png'), job = { statePath: join(dir, 'state.json'), phases: {} };
    await assert.rejects(checkpoint(job, 'cards', [file], async () => { throw new Error('render failed'); }), /render failed/);
    const resumed = await readJSON(job.statePath); assert.equal(resumed.phases.cards, undefined);
    await checkpoint(resumed, 'cards', [file], () => writeFile(file, 'png-result'));
    assert.equal((await readJSON(job.statePath)).phases.cards.files[file].bytes, 10);
  } finally { await rm(dir, { recursive: true }); }
});

test('锁拒绝并发且异常释放，仅一次执行动作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-lock-'));
  try {
    await withLock(dir, async () => {
      await assert.rejects(withLock(dir, () => assert.fail('must not run')), /已被锁定/);
    });
    await assert.rejects(withLock(dir, () => { throw new Error('failed'); }), /failed/);
    await withLock(dir, async () => {});
  } finally { await rm(dir, { recursive: true }); }
});
