import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const safeError = error => String(error?.message || error)
  .replace(/https?:\/\/\S+/g, '[网址已省略]').slice(0, 1200);

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

// No shell, inherited secrets never printed, and no retry/status-query loop.
export function run(bin, args, { signal, timeout = 30 * 60_000, env, onOutput, captureStderr = false, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('操作已取消')); return; }
    const child = spawn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: env || process.env });
    let stdout = '', stderr = '', failure, hardKill;
    const killGroup = name => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); }
      catch (error) { if (error.code !== 'ESRCH') failure ||= new Error('无法结束本次子进程组'); }
    };
    const stop = reason => {
      failure ||= new Error(reason); killGroup('SIGTERM');
      hardKill ||= setTimeout(() => killGroup('SIGKILL'), 1500);
    };
    const cancel = () => stop('操作已取消');
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(captureStderr ? -6_000_000 : -4000); });
    const timer = setTimeout(() => stop('单次操作超时'), timeout);
    child.on('error', error => { failure ||= error; });
    child.on('close', (code, reason) => {
      clearTimeout(timer); if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', cancel);
      // Even when the direct child exits early, its task-owned descendants must
      // stop before a failed phase releases its exclusive pipeline lock.
      if (failure || code !== 0) killGroup('SIGKILL');
      if (failure) reject(failure);
      else if (code === 0) resolve(stdout + (captureStderr ? '\n' + stderr : ''));
      else reject(new Error(`${basename(bin)} 退出 ${code ?? reason}：${safeError(stderr)}`));
    });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

export async function fingerprint(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

export async function withLock(root, action) {
  await mkdir(root, { recursive: true });
  const lock = join(root, '.processing');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = await readJSON(join(lock, 'owner.json')); } catch { /* Incomplete owner stays locked. */ }
    throw new Error(`流水线已被锁定${owner?.pid ? `（进程 ${owner.pid}）` : ''}；核实旧进程结束后用 unlock 显式恢复。`);
  }
  try { await writeJSON(join(lock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() }); return await action(); }
  finally { await rm(lock, { recursive: true }); }
}

export async function unlock(root) {
  const lock = join(root, '.processing');
  const owner = await readJSON(join(lock, 'owner.json'));
  try { process.kill(owner.pid, 0); throw new Error('旧流水线进程仍存在，不能解锁。'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await rm(lock, { recursive: true });
}

export async function checkpoint(job, phase, paths, action, emit = () => {}) {
  const existing = job.phases?.[phase];
  if (existing) {
    for (const [path, expected] of Object.entries(existing.files)) {
      const actual = await fingerprint(path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
        throw new Error(`阶段产物已变化：${phase}/${basename(path)}`);
    }
    return;
  }
  job.status = 'running'; job.phase = phase; delete job.error;
  await writeJSON(job.statePath, job); emit({ bvid: job.bvid, phase, status: 'running' });
  await action();
  const files = {};
  for (const path of typeof paths === 'function' ? await paths() : paths) { if (!(await stat(path)).isFile()) throw new Error('阶段产物不是文件'); files[path] = await fingerprint(path); }
  job.phases ||= {}; job.phases[phase] = { completedAt: new Date().toISOString(), files };
  await writeJSON(job.statePath, job); emit({ bvid: job.bvid, phase, status: 'complete' });
}
