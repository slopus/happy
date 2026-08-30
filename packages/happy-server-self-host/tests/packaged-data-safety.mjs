#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TASK_ROOT_PREFIX = 'happy-self-host-data-safety-';
const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export function assertOwnedTaskRoot(path) {
  let actual;
  let stat;

  try {
    actual = realpathSync(path);
    stat = lstatSync(path);
  } catch {
    throw new Error(`Refusing unsafe task root: ${path}`);
  }

  const declaredRoot = process.env.HAPPY_DATA_SAFETY_TASK_ROOT;
  const expectedParent = declaredRoot
    ? dirname(realpathSync(declaredRoot))
    : realpathSync(tmpdir());
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(actual) !== expectedParent ||
    (declaredRoot && actual !== realpathSync(declaredRoot)) ||
    !basename(actual).startsWith(TASK_ROOT_PREFIX)
  ) {
    throw new Error(`Refusing unsafe task root: ${path}`);
  }

  return actual;
}

function assertTaskPath(taskRoot, path) {
  const root = assertOwnedTaskRoot(taskRoot);
  const candidate = resolve(path);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing path outside task root: ${path}`);
  }
  return candidate;
}

export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function selectMigrationPrefix(migrations, cutoff) {
  const sorted = [...migrations].sort();
  if (!sorted.includes(cutoff)) {
    throw new Error(`Pinned migration cutoff is missing: ${cutoff}`);
  }
  const oldMigrations = sorted.filter(name => name <= cutoff);
  const pendingMigrations = sorted.filter(name => name > cutoff);
  if (pendingMigrations.length === 0) {
    throw new Error('The old state must leave at least one migration pending');
  }
  return { oldMigrations, pendingMigrations };
}

export function compileNetworkGuard(taskRoot) {
  const root = assertOwnedTaskRoot(taskRoot);
  const output = join(root, 'network-guard.so');
  const source = join(TESTS_DIRECTORY, 'network-guard.c');
  const compiled = spawnSync(
    process.env.CC || 'cc',
    ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-O2', '-o', output, source, '-ldl'],
    { encoding: 'utf8' },
  );
  if (compiled.status !== 0) {
    throw new Error(`Network guard compilation failed: ${compiled.stderr || compiled.stdout}`);
  }
  return output;
}

export function runNetworkGuardControls({ taskRoot, guard }) {
  const root = assertOwnedTaskRoot(taskRoot);
  const guardPath = assertTaskPath(root, guard);
  const log = join(root, 'network-positive-controls.log');
  if (existsSync(log)) rmSync(log);
  const env = {
    ...process.env,
    LD_PRELOAD: guardPath,
    HAPPY_NETWORK_GUARD_LOG: log,
  };

  const direct = spawnSync(
    process.execPath,
    ['-e', `
      const net = require('node:net');
      const socket = net.connect(443, '1.1.1.1');
      socket.once('connect', () => process.exit(19));
      socket.once('error', error => process.exit(error.code === 'ENETUNREACH' ? 17 : 20));
      setTimeout(() => process.exit(21), 2000);
    `],
    { env, encoding: 'utf8', timeout: 5_000 },
  );
  if (direct.status !== 17) {
    throw new Error(`Direct-IP positive control was not rejected as expected: ${direct.stderr || direct.stdout}`);
  }

  const dns = spawnSync(
    process.execPath,
    ['-e', `
      require('node:dns').lookup('api.cluster-fluster.com', error => {
        process.exit(error ? 18 : 19);
      });
    `],
    { env, encoding: 'utf8', timeout: 5_000 },
  );
  if (dns.status !== 18) {
    throw new Error(`DNS positive control was not rejected as expected: ${dns.stderr || dns.stdout}`);
  }

  const logBeforeLoopback = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const loopback = spawnSync(
    process.execPath,
    ['-e', `
      const net = require('node:net');
      const server = net.createServer(socket => socket.end('ok'));
      server.listen(0, '127.0.0.1', () => {
        const client = net.connect(server.address().port, '127.0.0.1');
        client.on('data', () => {});
        client.on('end', () => server.close(() => process.exit(0)));
        client.on('error', () => process.exit(22));
      });
      setTimeout(() => process.exit(23), 2000);
    `],
    { env, encoding: 'utf8', timeout: 5_000 },
  );
  const logAfterLoopback = existsSync(log) ? readFileSync(log, 'utf8') : '';
  if (loopback.status !== 0 || logAfterLoopback !== logBeforeLoopback) {
    throw new Error(`Loopback control failed or emitted an egress record: ${loopback.stderr || loopback.stdout}`);
  }

  return { log: logAfterLoopback, loopbackExitCode: loopback.status };
}

export function listSnapshotMembers(archive) {
  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (listed.status !== 0) {
    throw new Error(`Could not list snapshot: ${listed.stderr || listed.stdout}`);
  }

  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map(member => {
      if (member.startsWith('/')) {
        throw new Error(`Snapshot contains an unsafe absolute path: ${member}`);
      }
      const normalized = posix.normalize(member.replace(/^\.\//, ''));
      if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Snapshot contains an unsafe parent path: ${member}`);
      }
      return normalized.replace(/\/$/, '');
    });
}

export function restoreSnapshot({ taskRoot, archive, target, expectedHashes }) {
  const root = assertOwnedTaskRoot(taskRoot);
  const archivePath = assertTaskPath(root, archive);
  const targetPath = assertTaskPath(root, target);
  if (!existsSync(archivePath) || lstatSync(archivePath).isSymbolicLink()) {
    throw new Error(`Snapshot archive is missing or unsafe: ${archive}`);
  }

  const targetExisted = existsSync(targetPath);
  if (targetExisted) {
    const targetStat = lstatSync(targetPath);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || readdirSync(targetPath).length > 0) {
      throw new Error(`Restore target must be a new empty directory: ${target}`);
    }
  }

  const members = new Set(listSnapshotMembers(archivePath));
  const missing = [...expectedHashes.keys()].filter(path => !members.has(path));
  if (missing.length > 0) {
    throw new Error(`Snapshot is incomplete; missing: ${missing.join(', ')}`);
  }

  const staging = mkdtempSync(join(dirname(targetPath), '.restore-staging-'));
  assertTaskPath(root, staging);
  try {
    const extracted = spawnSync('tar', ['-xf', archivePath, '-C', staging], { encoding: 'utf8' });
    if (extracted.status !== 0) {
      throw new Error(`Snapshot extraction failed: ${extracted.stderr || extracted.stdout}`);
    }

    for (const [relativePath, expectedHash] of expectedHashes) {
      const restored = assertTaskPath(root, join(staging, relativePath));
      if (!existsSync(restored) || lstatSync(restored).isSymbolicLink()) {
        throw new Error(`Snapshot is incomplete after extraction: ${relativePath}`);
      }
      const actualHash = fileSha256(restored);
      if (actualHash !== expectedHash) {
        throw new Error(`Snapshot hash mismatch for ${relativePath}`);
      }
    }

    const secret = join(staging, 'server-data', 'master-secret');
    if ((statSync(secret).mode & 0o777) !== 0o600) {
      throw new Error('Snapshot master-secret mode is not 0600');
    }

    if (targetExisted) rmdirSync(targetPath);
    renameSync(staging, targetPath);
  } finally {
    if (existsSync(staging)) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
