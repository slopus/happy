#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { arch, homedir, release, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import tweetnacl from 'tweetnacl';

import {
  assertOwnedTaskRoot,
  compileNetworkGuard,
  fileSha256,
  listSnapshotMembers,
  restoreSnapshot,
  runNetworkGuardControls,
  selectMigrationPrefix,
} from './packaged-data-safety.mjs';

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TESTS_DIRECTORY, '../../..');
const MIGRATION_CUTOFF = '20260407053500_add_voice_conversation';
const SETTINGS_WRITE_FLAG = '--i-understand-this-will-modify-default-happy-settings';
const OFFICIAL_API_HOST = 'api.cluster-fluster.com';
const ATTACHMENT = Buffer.from('self-host-data-safety\0packaged-attachment\n', 'utf8');
const REQUIRED_TOOLS = ['cc', 'ip', 'mount', 'npm', 'pnpm', 'script', 'tar', 'unshare'];
const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;

let activeProcessGroup;
let activeTaskRoot;
const workerServerGroups = new Set();

function note(message) {
  process.stderr.write(`[self-host-data-safety] ${message}\n`);
}

function tail(value, size = 12_000) {
  return String(value || '').slice(-size);
}

function executableOnPath(command) {
  if (command.includes('/')) {
    try {
      accessSync(command, fsConstants.X_OK);
      return resolve(command);
    } catch {
      return undefined;
    }
  }
  for (const directory of (process.env.PATH || '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return undefined;
}

function assertPrerequisites() {
  if (process.platform !== 'linux') {
    throw new Error('Unsupported platform: packaged self-host data safety is verified on Linux Native only');
  }
  for (const command of REQUIRED_TOOLS) {
    if (!executableOnPath(command)) throw new Error(`Required tool is missing: ${command}`);
  }
  const bun = executableOnPath(process.env.HAPPY_DATA_SAFETY_BUN || 'bun');
  if (!bun) {
    throw new Error(
      'Required Bun build tool is missing. Install it task-locally and prepend that bin directory to PATH.',
    );
  }
  return bun;
}

function phaseLogPath(taskRoot, label) {
  const logs = join(taskRoot, 'logs');
  mkdirSync(logs, { recursive: true });
  return join(logs, `${label.replace(/[^a-z0-9.-]+/gi, '-')}.log`);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout || 10 * 60_000,
    maxBuffer: MAX_CAPTURE_BYTES,
    input: options.input,
  });
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  if (options.taskRoot && options.label) {
    writeFileSync(phaseLogPath(options.taskRoot, options.label), combined, { mode: 0o600 });
  }
  if (result.error || result.status !== (options.expectedStatus ?? 0)) {
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`${options.label || basename(command)} failed (${reason}):\n${tail(combined)}`);
  }
  return { ...result, combined };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function textSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function taskPath(taskRoot, path) {
  const root = assertOwnedTaskRoot(taskRoot);
  const candidate = resolve(path);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing path outside task root: ${candidate}`);
  }
  return candidate;
}

function removeCompletedRunRoot(taskRoot, runRoot) {
  const root = assertOwnedTaskRoot(taskRoot);
  const candidate = taskPath(root, runRoot);
  const stat = lstatSync(candidate);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(candidate) !== root ||
    !/^run-\d+$/.test(basename(candidate))
  ) {
    throw new Error(`Refusing unsafe completed run cleanup: ${runRoot}`);
  }
  rmSync(candidate, { recursive: true, force: true });
  assert.equal(existsSync(candidate), false);
}

function directoryEntriesFingerprint(directory) {
  if (!existsSync(directory)) return { exists: false };
  const stat = lstatSync(directory);
  return {
    exists: true,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode & 0o777,
    entries: readdirSync(directory).sort().map(name => {
      const path = join(directory, name);
      const entry = lstatSync(path);
      return {
        name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        link: entry.isSymbolicLink() ? readlinkSync(path) : undefined,
      };
    }),
  };
}

function fileFingerprint(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, type: stat.isSymbolicLink() ? 'symlink' : 'other' };
  }
  return {
    exists: true,
    size: stat.size,
    mode: stat.mode & 0o777,
    sha256: fileSha256(path),
  };
}

function daemonFingerprint() {
  const result = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const daemonIndex = command.indexOf('daemon');
      if (daemonIndex === -1 || command[daemonIndex + 1] !== 'start-sync') continue;
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      result.push({ pid: Number(name), startTicks: afterCommand[19], command });
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }
  return result.sort((a, b) => a.pid - b.pid);
}

function captureHostState() {
  const npmRootResult = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000 });
  if (npmRootResult.status !== 0) throw new Error(`Could not inspect global npm root: ${npmRootResult.stderr}`);
  const globalNpmRoot = npmRootResult.stdout.trim();
  const realHappy = join(homedir(), '.happy');
  return {
    globalNpmRoot,
    globalNpmEntries: directoryEntriesFingerprint(globalNpmRoot),
    realHappy,
    realHappyRoot: directoryEntriesFingerprint(realHappy),
    realSettings: fileFingerprint(join(realHappy, 'settings.json')),
    daemons: daemonFingerprint(),
  };
}

function assertHostStateUnchanged(before, after) {
  assert.deepEqual(after, before, 'real Happy settings/root, global npm, or running daemon state changed');
}

function treeManifest(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in proof home: ${path}`);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const stat = statSync(path);
        files.push({
          path: relative(root, path).split(sep).join('/'),
          sha256: fileSha256(path),
          size: stat.size,
          mode: stat.mode & 0o777,
        });
      }
    }
  };
  walk(root);
  return files;
}

function manifestDigest(manifest) {
  return textSha256(stableJson(manifest));
}

function tarballLedger(path, requiredMembers) {
  const members = listSnapshotMembers(path);
  for (const required of requiredMembers) {
    if (!members.some(member => member === required || member.startsWith(`${required}/`))) {
      throw new Error(`${basename(path)} is missing required member ${required}`);
    }
  }
  const stat = statSync(path);
  return { file: basename(path), sha256: fileSha256(path), bytes: stat.size, memberCount: members.length };
}

function packOne({ taskRoot, filter, label, artifactsDirectory, env }) {
  const before = new Set(readdirSync(artifactsDirectory));
  runChecked(
    'pnpm',
    ['--filter', filter, '--fail-if-no-match', 'pack', '--pack-destination', artifactsDirectory],
    { cwd: REPOSITORY_ROOT, env, taskRoot, label: `pack-${label}` },
  );
  const created = readdirSync(artifactsDirectory).filter(name => !before.has(name) && name.endsWith('.tgz'));
  if (created.length !== 1) throw new Error(`Expected one ${label} tarball, found ${created.join(', ')}`);
  return join(artifactsDirectory, created[0]);
}

function buildAndPack(taskRoot, bun) {
  note('building Happy Wire, CLI, self-host runtime and webapp');
  const artifactsDirectory = join(taskRoot, 'artifacts');
  mkdirSync(artifactsDirectory, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${dirname(bun)}:${process.env.PATH || ''}`,
    HAPPY_DATA_SAFETY_BUN: bun,
  };

  runChecked('pnpm', ['--filter', '@slopus/happy-wire', '--fail-if-no-match', 'build'], {
    cwd: REPOSITORY_ROOT, env, taskRoot, label: 'build-wire',
  });
  runChecked('pnpm', ['--filter', 'happy', '--fail-if-no-match', 'build'], {
    cwd: REPOSITORY_ROOT, env, taskRoot, label: 'build-cli',
  });
  runChecked('pnpm', ['--filter', 'happy-server-self-host', '--fail-if-no-match', 'build'], {
    cwd: REPOSITORY_ROOT, env, taskRoot, label: 'build-self-host',
  });
  runChecked('pnpm', ['--filter', 'happy-server-self-host', '--fail-if-no-match', 'run', 'bundle:webapp'], {
    cwd: REPOSITORY_ROOT, env, taskRoot, label: 'build-self-host-webapp',
  });

  const wire = packOne({ taskRoot, filter: '@slopus/happy-wire', label: 'wire', artifactsDirectory, env });
  const cli = packOne({ taskRoot, filter: 'happy', label: 'cli', artifactsDirectory, env });
  const server = packOne({ taskRoot, filter: 'happy-server-self-host', label: 'self-host', artifactsDirectory, env });

  return {
    paths: { wire, cli, server },
    ledger: {
      wire: tarballLedger(wire, ['package/package.json', 'package/dist']),
      cli: tarballLedger(cli, ['package/package.json', 'package/bin/happy.mjs', 'package/dist/index.mjs']),
      server: tarballLedger(server, [
        'package/package.json',
        'package/bin/happy-server.cjs',
        'package/dist/standalone.mjs',
        'package/prisma/schema.prisma',
        `package/prisma/migrations/${MIGRATION_CUTOFF}/migration.sql`,
        'package/webapp/index.html',
      ]),
    },
  };
}

function installArtifacts(taskRoot, runRoot, artifacts, runId) {
  note(`${runId}: installing tgz files under a fresh task-local npm prefix`);
  const prefix = join(runRoot, 'npm-prefix');
  const cache = join(runRoot, 'npm-cache');
  const npmHome = join(runRoot, 'npm-home');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(npmHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: npmHome,
    npm_config_cache: cache,
    npm_config_prefix: prefix,
    npm_config_update_notifier: 'false',
  };
  runChecked(
    'npm',
    [
      'install',
      '--prefix', prefix,
      '--cache', cache,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      artifacts.wire,
      artifacts.server,
      artifacts.cli,
    ],
    { cwd: runRoot, env, taskRoot, label: `npm-install-${runId}`, timeout: 15 * 60_000 },
  );

  const happy = realpathSync(join(prefix, 'node_modules', '.bin', 'happy'));
  const happyServer = realpathSync(join(prefix, 'node_modules', '.bin', 'happy-server'));
  const serverPackage = realpathSync(join(prefix, 'node_modules', 'happy-server-self-host'));
  const runtime = realpathSync(join(serverPackage, 'dist', 'standalone.mjs'));
  for (const binary of [happy, happyServer, serverPackage, runtime]) {
    assert.ok(binary.startsWith(`${realpathSync(prefix)}${sep}`), `installed artifact escaped prefix: ${binary}`);
    assert.ok(!binary.startsWith(`${REPOSITORY_ROOT}${sep}`), `installed artifact resolved to source: ${binary}`);
  }
  return { prefix, cache, happy, happyServer, serverPackage, runtime };
}

async function chooseHostUnusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a test port'));
        return;
      }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function hostPortAcceptsConnections(port) {
  return new Promise(resolveResult => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => {
      socket.destroy();
      resolveResult(value);
    };
    socket.setTimeout(350, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function appendCapped(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function signalProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function terminateProcessGroup(pid) {
  signalProcessGroup(pid, 'SIGTERM');
  await delay(1_500);
  signalProcessGroup(pid, 'SIGKILL');
}

function taskProcesses(taskRoot) {
  const matches = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (command.some(argument => argument.includes(taskRoot))) {
        matches.push({ pid: Number(name), command });
      }
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }
  return matches;
}

function workerEnvironment({ taskRoot, runRoot, install, guard, productLog }) {
  const workerHome = join(runRoot, 'os-home');
  const proofHome = join(runRoot, 'proof-home');
  const workerTmp = join(runRoot, 'tmp');
  for (const directory of [workerHome, proofHome, workerTmp]) mkdirSync(directory, { recursive: true });
  return {
    PATH: `${join(install.prefix, 'node_modules', '.bin')}:${process.env.PATH || ''}`,
    HOME: workerHome,
    HAPPY_HOME_DIR: proofHome,
    TMPDIR: workerTmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    HAPPY_DISABLE_CAFFEINATE: '1',
    LD_PRELOAD: guard,
    HAPPY_NETWORK_GUARD_LOG: productLog,
    HAPPY_DATA_SAFETY_TASK_ROOT: taskRoot,
  };
}

async function runNamespaceWorker({ taskRoot, runRoot, runId, install, guard, port, realHappy }) {
  const configPath = join(runRoot, 'worker-config.json');
  const evidencePath = join(runRoot, 'worker-evidence.json');
  const readyMarker = join(runRoot, 'namespace-server-ready');
  const hostIsolationAck = join(runRoot, 'host-isolation-ack');
  const productLog = join(runRoot, 'product-egress.log');
  const workerLog = join(runRoot, 'worker.log');
  const sandboxCwd = join(runRoot, 'sandbox-cwd');
  const realHappyShadow = join(runRoot, 'real-happy-shadow');
  mkdirSync(sandboxCwd, { recursive: true });
  mkdirSync(realHappyShadow, { recursive: true });

  const config = {
    taskRoot,
    runRoot,
    runId,
    port,
    ...install,
    evidencePath,
    readyMarker,
    hostIsolationAck,
    productLog,
    sandboxCwd,
    realHappy,
    realHappyShadow,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = workerEnvironment({ taskRoot, runRoot, install, guard, productLog });
  if (await hostPortAcceptsConnections(port)) {
    throw new Error(`Selected host port ${port} became occupied before namespace start`);
  }

  note(`${runId}: entering user/mount/network/PID namespaces with loopback only`);
  const child = spawn(
    'unshare',
    [
      '--user',
      '--map-root-user',
      '--mount',
      '--net',
      '--pid',
      '--fork',
      '--kill-child=SIGKILL',
      '--mount-proc',
      '--propagation',
      'private',
      process.execPath,
      fileURLToPath(import.meta.url),
      '--worker',
      configPath,
    ],
    { cwd: sandboxCwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  activeProcessGroup = child.pid;
  let output = '';
  child.stdout.on('data', chunk => { output = appendCapped(output, chunk); });
  child.stderr.on('data', chunk => { output = appendCapped(output, chunk); });
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  let exit;
  let hostIsolationChecked = false;
  const deadline = Date.now() + 10 * 60_000;
  try {
    while (!exit) {
      const event = await Promise.race([
        exitPromise.then(value => ({ type: 'exit', value })),
        delay(40).then(() => ({ type: 'tick' })),
      ]);
      if (event.type === 'exit') {
        exit = event.value;
        break;
      }
      if (!hostIsolationChecked && existsSync(readyMarker)) {
        if (await hostPortAcceptsConnections(port)) {
          throw new Error(`Namespace-local server leaked onto host port ${port}`);
        }
        hostIsolationChecked = true;
        writeFileSync(hostIsolationAck, 'host port remained closed\n', { mode: 0o600 });
      }
      if (Date.now() > deadline) throw new Error(`${runId} namespace worker timed out`);
    }
  } catch (error) {
    await terminateProcessGroup(child.pid);
    throw error;
  } finally {
    activeProcessGroup = undefined;
    writeFileSync(workerLog, output, { mode: 0o600 });
  }

  if (exit.code !== 0) {
    throw new Error(`${runId} namespace worker exited ${exit.code ?? exit.signal}:\n${tail(output)}`);
  }
  assert.ok(hostIsolationChecked, `${runId} never reached the host-port isolation checkpoint`);
  assert.equal(await hostPortAcceptsConnections(port), false, `host port ${port} changed after worker exit`);
  const remaining = taskProcesses(taskRoot);
  assert.deepEqual(remaining, [], `task-owned processes survived ${runId}`);
  if (!existsSync(evidencePath)) throw new Error(`${runId} did not write evidence`);
  return {
    ...JSON.parse(readFileSync(evidencePath, 'utf8')),
    hostPortInvisibleDuringRun: true,
    hostPortClosedAfterRun: true,
    taskProcessesAfterRun: 0,
  };
}

function sanitizedProductEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    CI: process.env.CI,
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    HAPPY_DISABLE_CAFFEINATE: process.env.HAPPY_DISABLE_CAFFEINATE,
    LD_PRELOAD: process.env.LD_PRELOAD,
    HAPPY_NETWORK_GUARD_LOG: process.env.HAPPY_NETWORK_GUARD_LOG,
    METRICS_ENABLED: 'false',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    ...overrides,
  };
}

function installedHappyArgs(happy, args) {
  return ['--no-warnings', '--no-deprecation', happy, ...args];
}

function runInstalledSmoke(config) {
  const env = sanitizedProductEnvironment({ HAPPY_HOME_DIR: join(config.runRoot, 'smoke-home') });
  mkdirSync(env.HAPPY_HOME_DIR, { recursive: true });
  const commands = [
    ['help', installedHappyArgs(config.happy, ['--help'])],
    ['version', installedHappyArgs(config.happy, ['--version'])],
    ['doctor', installedHappyArgs(config.happy, ['doctor'])],
    ['daemon-status', installedHappyArgs(config.happy, ['daemon', 'status'])],
  ];
  const evidence = {};
  for (const [label, args] of commands) {
    const result = runChecked(process.execPath, args, {
      cwd: config.sandboxCwd,
      env,
      taskRoot: config.taskRoot,
      label: `${config.runId}-installed-${label}`,
      timeout: 45_000,
    });
    evidence[label] = { exitCode: result.status, outputSha256: textSha256(result.combined) };
  }
  const serverHelp = runChecked(config.happyServer, ['--help'], {
    cwd: config.sandboxCwd,
    env,
    taskRoot: config.taskRoot,
    label: `${config.runId}-installed-server-help`,
    timeout: 30_000,
  });
  evidence.serverHelp = { exitCode: serverHelp.status, outputSha256: textSha256(serverHelp.combined) };
  return evidence;
}

function startPackagedServer(config, happyHome, label) {
  const env = sanitizedProductEnvironment({ HAPPY_HOME_DIR: happyHome });
  mkdirSync(happyHome, { recursive: true });
  const child = spawn(
    process.execPath,
    installedHappyArgs(config.happy, [
      'server',
      '--port', String(config.port),
      '--host', '127.0.0.1',
      SETTINGS_WRITE_FLAG,
    ]),
    { cwd: config.sandboxCwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', chunk => { output = appendCapped(output, chunk); });
  child.stderr.on('data', chunk => { output = appendCapped(output, chunk); });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  workerServerGroups.add(child.pid);
  return { child, exit, label, output: () => output };
}

async function fetchWithTimeout(url, init = {}) {
  const { timeout = 3_000, ...request } = init;
  return fetch(url, { ...request, signal: AbortSignal.timeout(timeout) });
}

async function waitForServer(baseUrl, running) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      throw new Error(`Server exited before health check: ${tail(running.output())}`);
    }
    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`);
      const body = await response.json();
      if (response.ok && body.status === 'ok' && body.service === 'happy-server') return body;
    } catch {
      // PGlite initialization and Prisma generation can take several seconds.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for packaged server: ${tail(running.output())}`);
}

async function stopPackagedServer(config, running) {
  if (running.child.exitCode === null) running.child.kill('SIGTERM');
  const result = await Promise.race([
    running.exit,
    delay(25_000).then(() => ({ timeout: true })),
  ]);
  if (result.timeout) {
    await terminateProcessGroup(running.child.pid);
    throw new Error(`Graceful shutdown timed out: ${tail(running.output())}`);
  }
  const output = running.output();
  workerServerGroups.delete(running.child.pid);
  writeFileSync(join(config.runRoot, `${running.label}.log`), output, { mode: 0o600 });
  if (result.code !== 0) {
    throw new Error(`Packaged server exited ${result.code ?? result.signal}: ${tail(output)}`);
  }
  assert.match(output, /mode:\s+happy-server-self-host/, 'CLI did not use installed self-host package');
  assert.doesNotMatch(output, /source \(dev\)|Could not locate happy-server/i);
  return output;
}

async function jsonRequest(url, init) {
  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${url} failed ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function authenticate(baseUrl) {
  const keypair = tweetnacl.sign.keyPair();
  const challenge = randomBytes(48);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
  const response = await jsonRequest(`${baseUrl}/v1/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: Buffer.from(keypair.publicKey).toString('base64'),
      challenge: challenge.toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
    }),
  });
  assert.equal(response.success, true);
  assert.ok(response.token);
  return response.token;
}

function authenticatedRequest(token, body) {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function verifyPublicState(baseUrl, token, expected) {
  const account = await jsonRequest(
    `${baseUrl}/v1/account/settings`,
    authenticatedRequest(token),
  );
  assert.equal(account.settings, expected.settings);
  assert.equal(account.settingsVersion, 1);

  const sessions = await jsonRequest(`${baseUrl}/v1/sessions`, authenticatedRequest(token));
  const session = sessions.sessions.find(candidate => candidate.id === expected.sessionId);
  assert.ok(session, `session ${expected.sessionId} was not returned`);
  assert.equal(session.metadata, expected.metadata);

  const response = await fetchWithTimeout(
    `${baseUrl}/v1/sessions/${expected.sessionId}/attachments/${expected.attachmentFile}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(response.ok, true, `attachment download failed with ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.attachmentSha256);
  return {
    accountSettingsVersion: account.settingsVersion,
    sessionId: session.id,
    attachmentSha256: expected.attachmentSha256,
  };
}

async function writePublicState(baseUrl, token, runId) {
  const settings = JSON.stringify({ proof: 'self-host-data-safety', runId });
  const settingsWrite = await jsonRequest(
    `${baseUrl}/v1/account/settings`,
    authenticatedRequest(token, { settings, expectedVersion: 0 }),
  );
  assert.equal(settingsWrite.success, true);
  assert.equal(settingsWrite.version, 1);

  const metadata = `metadata-${runId}`;
  const created = await jsonRequest(
    `${baseUrl}/v1/sessions`,
    authenticatedRequest(token, { tag: `tag-${runId}`, metadata }),
  );
  const upload = await jsonRequest(
    `${baseUrl}/v1/sessions/${created.session.id}/attachments/request-upload`,
    authenticatedRequest(token, { filename: 'data-safety.enc', size: ATTACHMENT.length }),
  );
  assert.equal(upload.method, 'PUT');
  assert.ok(upload.uploadUrl.startsWith(baseUrl), `upload URL was not local: ${upload.uploadUrl}`);
  const uploaded = await fetchWithTimeout(upload.uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    body: ATTACHMENT,
  });
  assert.equal(uploaded.ok, true, `attachment upload failed with ${uploaded.status}`);
  const attachmentFile = upload.ref.split('/').at(-1);
  assert.ok(attachmentFile);
  return {
    settings,
    metadata,
    sessionId: created.session.id,
    attachmentFile,
    attachmentSha256: createHash('sha256').update(ATTACHMENT).digest('hex'),
  };
}

async function waitForHostIsolationAck(config, running) {
  writeFileSync(config.readyMarker, `namespace server listening on ${config.port}\n`, { mode: 0o600 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(config.hostIsolationAck)) return;
    if (running.child.exitCode !== null) {
      throw new Error(`Server exited before host isolation was checked: ${tail(running.output())}`);
    }
    await delay(40);
  }
  throw new Error('Parent did not acknowledge host-port isolation');
}

async function assertStaticAndHealth(baseUrl, running) {
  const health = await waitForServer(baseUrl, running);
  const response = await fetchWithTimeout(`${baseUrl}/`);
  const html = await response.text();
  assert.equal(response.ok, true);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(html, /window\.__HAPPY_CONFIG__/);
  assert.ok(html.includes(JSON.stringify(baseUrl)), 'static config did not contain the loopback server URL');
  assert.match(html, /"disableAnalytics":true/);
  return { health, htmlSha256: textSha256(html), bytes: Buffer.byteLength(html) };
}

async function runPersistenceAndRecovery(config) {
  note(`${config.runId}: proving packaged static/health, persistence, restart, backup and restore`);
  const originalHome = process.env.HAPPY_HOME_DIR;
  const restoredHome = join(config.runRoot, 'restored-home');
  const invalidTarget = join(config.runRoot, 'invalid-restore-home');
  const backup = join(config.runRoot, 'happy-home.tar');
  const incompleteBackup = join(config.runRoot, 'incomplete-happy-home.tar');
  const baseUrl = `http://127.0.0.1:${config.port}`;

  let running = startPackagedServer(config, originalHome, 'server-initial');
  const staticAndHealth = await assertStaticAndHealth(baseUrl, running);
  await waitForHostIsolationAck(config, running);
  const token = await authenticate(baseUrl);
  const expected = await writePublicState(baseUrl, token, config.runId);
  const initialRead = await verifyPublicState(baseUrl, token, expected);
  await stopPackagedServer(config, running);

  const settingsFile = join(originalHome, 'settings.json');
  const secretFile = join(originalHome, 'server-data', 'master-secret');
  const pgliteDirectory = join(originalHome, 'server-data', 'pglite');
  const attachmentFile = join(
    originalHome,
    'server-data',
    'files',
    'sessions',
    expected.sessionId,
    'attachments',
    expected.attachmentFile,
  );
  assert.ok(existsSync(settingsFile));
  assert.ok(existsSync(secretFile));
  assert.ok(existsSync(pgliteDirectory) && readdirSync(pgliteDirectory).length > 0);
  assert.ok(existsSync(attachmentFile));
  assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(secretFile, 'utf8').trim().length, 64);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.serverUrl, baseUrl);
  assert.equal(settings.webappUrl, baseUrl);

  running = startPackagedServer(config, originalHome, 'server-restart');
  await waitForServer(baseUrl, running);
  const restartRead = await verifyPublicState(baseUrl, token, expected);
  await stopPackagedServer(config, running);

  const beforeManifest = treeManifest(originalHome);
  const beforeManifestDigest = manifestDigest(beforeManifest);
  const expectedHashes = new Map(beforeManifest.map(file => [file.path, file.sha256]));
  const backupResult = runChecked('tar', ['-cf', backup, '-C', originalHome, '.'], {
    cwd: config.sandboxCwd,
    taskRoot: config.taskRoot,
    label: `${config.runId}-snapshot-create`,
  });
  assert.equal(backupResult.status, 0);
  const backupSha256 = fileSha256(backup);
  const backupBytes = statSync(backup).size;
  const backupMembers = listSnapshotMembers(backup);
  const normalizedMemberList = `${backupMembers.join('\n')}\n`;

  runChecked('tar', ['-cf', incompleteBackup, '-C', originalHome, 'settings.json'], {
    cwd: config.sandboxCwd,
    taskRoot: config.taskRoot,
    label: `${config.runId}-snapshot-incomplete`,
  });
  mkdirSync(invalidTarget);
  assert.throws(
    () => restoreSnapshot({
      taskRoot: config.taskRoot,
      archive: incompleteBackup,
      target: invalidTarget,
      expectedHashes,
    }),
    /snapshot is incomplete/i,
  );
  assert.deepEqual(readdirSync(invalidTarget), []);
  assert.equal(manifestDigest(treeManifest(originalHome)), beforeManifestDigest);
  assert.equal(fileSha256(backup), backupSha256);

  mkdirSync(restoredHome);
  restoreSnapshot({ taskRoot: config.taskRoot, archive: backup, target: restoredHome, expectedHashes });
  const restoredManifest = treeManifest(restoredHome);
  assert.deepEqual(restoredManifest, beforeManifest);
  assert.equal(fileSha256(join(restoredHome, 'settings.json')), fileSha256(settingsFile));
  assert.equal(fileSha256(join(restoredHome, 'server-data', 'master-secret')), fileSha256(secretFile));
  assert.equal(
    fileSha256(join(
      restoredHome,
      'server-data',
      'files',
      'sessions',
      expected.sessionId,
      'attachments',
      expected.attachmentFile,
    )),
    expected.attachmentSha256,
  );

  running = startPackagedServer(config, restoredHome, 'server-restored');
  await waitForServer(baseUrl, running);
  const restoredRead = await verifyPublicState(baseUrl, token, expected);
  await stopPackagedServer(config, running);

  return {
    baseUrl,
    restoredHome,
    staticAndHealth,
    logicalState: { initialRead, restartRead, restoredRead },
    sessionId: expected.sessionId,
    attachmentSha256: expected.attachmentSha256,
    settingsSha256: fileSha256(settingsFile),
    masterSecretSha256: fileSha256(secretFile),
    masterSecretMode: statSync(secretFile).mode & 0o777,
    sourceTreeSha256: beforeManifestDigest,
    sourceFileCount: beforeManifest.length,
    snapshot: {
      sha256: backupSha256,
      bytes: backupBytes,
      normalizedMemberList: {
        count: backupMembers.length,
        sha256: textSha256(normalizedMemberList),
        criticalMembers: [
          'settings.json',
          'server-data/master-secret',
          'server-data/pglite',
          relative(originalHome, attachmentFile).split(sep).join('/'),
        ],
      },
    },
    invalidRestoreRolledBack: true,
  };
}

async function installedPGliteConstructor(serverPackage) {
  const requireFromServer = createRequire(join(serverPackage, 'package.json'));
  const entry = requireFromServer.resolve('@electric-sql/pglite');
  const module = await import(pathToFileURL(entry).href);
  assert.equal(typeof module.PGlite, 'function');
  return module.PGlite;
}

async function relatedMigrationRows(pg) {
  const result = await pg.query(`
    SELECT a."id" AS account_id,
           s."id" AS session_id,
           m."id" AS message_id,
           m."content"->>'type' AS marker
      FROM "Account" a
      JOIN "Session" s ON s."accountId" = a."id"
      JOIN "SessionMessage" m ON m."sessionId" = s."id"
     WHERE a."id" = 'account-old'
     ORDER BY m."seq"
  `);
  return result.rows;
}

async function runMigrationUpgrade(config) {
  note(`${config.runId}: upgrading a deterministic packaged old-migration state twice`);
  const migrationRoot = join(config.runRoot, 'migration-proof');
  const oldMigrationsDirectory = join(migrationRoot, 'old-migrations');
  const pgliteDirectory = join(migrationRoot, 'pglite');
  const currentMigrationsDirectory = join(config.serverPackage, 'prisma', 'migrations');
  mkdirSync(oldMigrationsDirectory, { recursive: true });
  const allMigrations = readdirSync(currentMigrationsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const { oldMigrations, pendingMigrations } = selectMigrationPrefix(allMigrations, MIGRATION_CUTOFF);
  for (const migration of oldMigrations) {
    const sql = join(currentMigrationsDirectory, migration, 'migration.sql');
    assert.ok(existsSync(sql), `packaged migration has no SQL: ${migration}`);
    cpSync(join(currentMigrationsDirectory, migration), join(oldMigrationsDirectory, migration), {
      recursive: true,
    });
  }

  const standalone = await import(`${pathToFileURL(config.runtime).href}?proof=${encodeURIComponent(config.runId)}`);
  assert.equal(typeof standalone.runMigrations, 'function');
  await standalone.runMigrations({ pgliteDir: pgliteDirectory, migrationsDir: oldMigrationsDirectory });

  const PGlite = await installedPGliteConstructor(config.serverPackage);
  let pg = new PGlite(pgliteDirectory);
  await pg.query(
    `INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES ($1, $2, now())`,
    ['account-old', 'public-key-old'],
  );
  await pg.query(
    `INSERT INTO "Session" ("id", "accountId", "tag", "metadata", "updatedAt") VALUES ($1, $2, $3, $4, now())`,
    ['session-old', 'account-old', 'tag-old', 'metadata-old'],
  );
  await pg.query(
    `INSERT INTO "SessionMessage" ("id", "sessionId", "seq", "content", "updatedAt") VALUES ($1, $2, $3, $4::jsonb, now())`,
    ['message-old', 'session-old', 1, JSON.stringify({ type: 'old-state-marker' })],
  );
  const oldRows = await relatedMigrationRows(pg);
  const oldLedger = await pg.query(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`,
  );
  await pg.close();
  assert.deepEqual(oldLedger.rows.map(row => row.migration_name), oldMigrations);

  const env = sanitizedProductEnvironment({
    DB_PROVIDER: 'pglite',
    DATA_DIR: migrationRoot,
    PGLITE_DIR: pgliteDirectory,
    HANDY_MASTER_SECRET: '51'.repeat(32),
    HOST: '127.0.0.1',
    PORT: String(config.port),
  });
  const upgraded = runChecked(config.happyServer, ['migrate'], {
    cwd: config.sandboxCwd,
    env,
    taskRoot: config.taskRoot,
    label: `${config.runId}-migration-upgrade`,
    timeout: 120_000,
  });
  for (const migration of pendingMigrations) assert.ok(upgraded.combined.includes(migration));

  pg = new PGlite(pgliteDirectory);
  const upgradedRows = await relatedMigrationRows(pg);
  const currentLedger = await pg.query(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`,
  );
  const projectTable = await pg.query(`SELECT to_regclass('public."Project"')::text AS name`);
  await pg.close();
  assert.deepEqual(upgradedRows, oldRows);
  assert.deepEqual(currentLedger.rows.map(row => row.migration_name), allMigrations);
  assert.ok(projectTable.rows[0]?.name, 'current Project schema marker was not created');

  const repeated = runChecked(config.happyServer, ['migrate'], {
    cwd: config.sandboxCwd,
    env,
    taskRoot: config.taskRoot,
    label: `${config.runId}-migration-repeat`,
    timeout: 120_000,
  });
  assert.match(repeated.combined, /No new migrations to apply\./);

  pg = new PGlite(pgliteDirectory);
  const repeatedRows = await relatedMigrationRows(pg);
  const repeatedLedger = await pg.query(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`,
  );
  await pg.close();
  assert.deepEqual(repeatedRows, upgradedRows);
  assert.deepEqual(repeatedLedger.rows, currentLedger.rows);

  return {
    cutoff: MIGRATION_CUTOFF,
    oldMigrationCount: oldMigrations.length,
    pendingMigrations,
    currentMigrationCount: allMigrations.length,
    relationship: upgradedRows[0],
    repeatedLedgerCount: repeatedLedger.rows.length,
    repeatReportedNoNewMigrations: true,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function runCliFailClosed(config, restoredHome, baseUrl) {
  note(`${config.runId}: proving packaged CLI fails closed after the configured self-host stops`);
  const settings = JSON.parse(readFileSync(join(restoredHome, 'settings.json'), 'utf8'));
  assert.equal(settings.serverUrl, baseUrl);
  assert.equal(settings.webappUrl, baseUrl);
  assert.ok(!existsSync(join(restoredHome, 'access.key')), 'proof home unexpectedly contains CLI credentials');

  const transcript = join(config.runRoot, 'cli-fail-closed.typescript');
  const command = [
    process.execPath,
    '--no-warnings',
    '--no-deprecation',
    config.happy,
    'auth',
    'login',
  ].map(shellQuote).join(' ');
  const child = spawn('script', ['-q', '-e', '-f', '-c', command, transcript], {
    cwd: config.sandboxCwd,
    env: sanitizedProductEnvironment({ HAPPY_HOME_DIR: restoredHome }),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  workerServerGroups.add(child.pid);
  let output = '';
  child.stdout.on('data', chunk => { output = appendCapped(output, chunk); });
  child.stderr.on('data', chunk => { output = appendCapped(output, chunk); });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  await delay(1_000);
  child.stdin.write('1');
  const result = await Promise.race([
    exit,
    delay(30_000).then(() => ({ timeout: true })),
  ]);
  if (result.timeout) {
    await terminateProcessGroup(child.pid);
    throw new Error(`CLI fail-closed pseudo-terminal timed out: ${tail(output)}`);
  }
  workerServerGroups.delete(child.pid);
  writeFileSync(phaseLogPath(config.taskRoot, `${config.runId}-cli-fail-closed`), output, { mode: 0o600 });
  assert.equal(result.code, 1, `CLI fail-closed command exited ${result.code ?? result.signal}: ${tail(output)}`);
  const combined = `${output}\n${readFileSync(transcript, 'utf8')}`;
  assert.match(combined, /Failed to create authentication request/i);
  assert.match(combined, /Authentication failed/i);
  assert.doesNotMatch(combined, new RegExp(OFFICIAL_API_HOST.replaceAll('.', '\\.')));
  return {
    exitCode: result.code,
    configuredServerUrl: settings.serverUrl,
    outputSha256: textSha256(combined),
    clearLocalFailure: true,
    officialApiMentioned: false,
  };
}

function assertProductEgressLogEmpty(path) {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (content.length > 0) throw new Error(`Undeclared product egress attempt detected:\n${content}`);
  return { path: basename(path), bytes: 0, sha256: textSha256('') };
}

async function workerMain(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assertOwnedTaskRoot(config.taskRoot);
  for (const path of [
    config.runRoot,
    config.evidencePath,
    config.readyMarker,
    config.hostIsolationAck,
    config.productLog,
    config.sandboxCwd,
    config.realHappyShadow,
    config.prefix,
    config.happy,
    config.happyServer,
    config.serverPackage,
    config.runtime,
  ]) taskPath(config.taskRoot, path);

  process.umask(0o077);
  let success = false;
  try {
    runChecked('ip', ['link', 'set', 'lo', 'up'], {
      taskRoot: config.taskRoot,
      label: `${config.runId}-loopback-up`,
    });
    const interfaces = runChecked('ip', ['-brief', 'address', 'show'], {
      taskRoot: config.taskRoot,
      label: `${config.runId}-interfaces`,
    }).combined.trim();
    const interfaceNames = interfaces.split('\n').filter(Boolean).map(line => line.trim().split(/\s+/)[0]);
    assert.deepEqual(interfaceNames, ['lo'], `namespace had non-loopback interfaces: ${interfaces}`);
    const ipv4Routes = runChecked('ip', ['route', 'show', 'table', 'all'], {
      taskRoot: config.taskRoot,
      label: `${config.runId}-ipv4-routes`,
    }).combined.trim();
    const ipv6Routes = runChecked('ip', ['-6', 'route', 'show', 'table', 'all'], {
      taskRoot: config.taskRoot,
      label: `${config.runId}-ipv6-routes`,
    }).combined.trim();
    for (const route of `${ipv4Routes}\n${ipv6Routes}`.split('\n').filter(Boolean)) {
      assert.match(route, /\bdev lo\b/, `namespace route escaped loopback: ${route}`);
      assert.doesNotMatch(route, /\b(default|via)\b/, `namespace had an external route: ${route}`);
    }

    let realHappyShadowed = false;
    if (existsSync(config.realHappy)) {
      runChecked('mount', ['--bind', config.realHappyShadow, config.realHappy], {
        taskRoot: config.taskRoot,
        label: `${config.runId}-shadow-real-happy`,
      });
      assert.deepEqual(readdirSync(config.realHappy), []);
      realHappyShadowed = true;
    }

    const controls = runNetworkGuardControls({ taskRoot: config.taskRoot, guard: process.env.LD_PRELOAD });
    assert.match(controls.log, /operation=connect target=1\.1\.1\.1:443/);
    assert.match(controls.log, new RegExp(`operation=dns target=${OFFICIAL_API_HOST.replaceAll('.', '\\.')}`));
    assertProductEgressLogEmpty(config.productLog);

    const installedSmoke = runInstalledSmoke(config);
    const persistence = await runPersistenceAndRecovery(config);
    const migration = await runMigrationUpgrade(config);
    const cliFailClosed = await runCliFailClosed(config, persistence.restoredHome, persistence.baseUrl);
    const productEgress = assertProductEgressLogEmpty(config.productLog);
    const { restoredHome: _restoredHome, ...persistenceEvidence } = persistence;

    const evidence = {
      runId: config.runId,
      platform: {
        claim: 'Linux Native only',
        platform: process.platform,
        arch: process.arch,
        kernel: release(),
        node: process.version,
      },
      isolation: {
        interfaces,
        routes: { ipv4: ipv4Routes, ipv6: ipv6Routes },
        realHappyShadowed,
        proofHome: relative(config.taskRoot, process.env.HAPPY_HOME_DIR),
      },
      networkPositiveControls: {
        directIpDetected: controls.log.includes('operation=connect target=1.1.1.1:443'),
        officialDnsDetected: controls.log.includes(`operation=dns target=${OFFICIAL_API_HOST}`),
        loopbackExitCode: controls.loopbackExitCode,
        logSha256: textSha256(controls.log),
      },
      installedSmoke,
      persistence: persistenceEvidence,
      migration,
      cliFailClosed,
      productEgress,
    };
    writeFileSync(config.evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    success = true;
  } finally {
    for (const pid of workerServerGroups) {
      try {
        signalProcessGroup(pid, 'SIGKILL');
      } catch {
        // Namespace teardown is the final process containment boundary.
      }
    }
    workerServerGroups.clear();
  }
  if (!success) process.exitCode = 1;
}

export function baselineEvidence() {
  const head = runChecked('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, label: 'git-head' }).stdout.trim();
  const expectedRef = process.env.HAPPY_DATA_SAFETY_BASELINE_REF;
  if (!expectedRef) {
    return { head, expectedRef: null, expectedCommit: null, exactMatch: null };
  }
  const expectedCommit = runChecked(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${expectedRef}^{commit}`],
    { cwd: REPOSITORY_ROOT, label: 'git-expected-baseline' },
  ).stdout.trim();
  assert.equal(head, expectedCommit, `proof worktree HEAD does not match ${expectedRef}`);
  return { head, expectedRef, expectedCommit, exactMatch: true };
}

function parseParentArgs(args) {
  let runs = 1;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--runs') {
      runs = Number(args[++index]);
    } else if (args[index] === '--help' || args[index] === '-h') {
      process.stdout.write(`Usage: node packaged-data-safety-e2e.mjs [--runs 1|2]\n`);
      return undefined;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 2) {
    throw new Error('--runs must be 1 or 2');
  }
  return { runs };
}

function installSignalCleanup() {
  const cleanup = signal => {
    try {
      if (activeProcessGroup) signalProcessGroup(activeProcessGroup, 'SIGKILL');
      if (activeTaskRoot && existsSync(activeTaskRoot)) {
        rmSync(assertOwnedTaskRoot(activeTaskRoot), { recursive: true, force: true });
      }
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
}

async function parentMain(args) {
  const options = parseParentArgs(args);
  if (!options) return;
  const bun = assertPrerequisites();
  const taskRoot = mkdtempSync(join(tmpdir(), 'happy-self-host-data-safety-'));
  activeTaskRoot = taskRoot;
  installSignalCleanup();
  let evidence;
  let failure;
  try {
    const hostBefore = captureHostState();
    const baseline = baselineEvidence();
    const guard = compileNetworkGuard(taskRoot);
    const built = buildAndPack(taskRoot, bun);
    const runs = [];
    for (let index = 1; index <= options.runs; index++) {
      const runId = `run-${index}`;
      const runRoot = join(taskRoot, runId);
      mkdirSync(runRoot, { recursive: true });
      const install = installArtifacts(taskRoot, runRoot, built.paths, runId);
      const port = await chooseHostUnusedPort();
      const runEvidence = await runNamespaceWorker({
        taskRoot,
        runRoot,
        runId,
        install,
        guard,
        port,
        realHappy: hostBefore.realHappy,
      });
      removeCompletedRunRoot(taskRoot, runRoot);
      runs.push({ ...runEvidence, runRootRemovedBeforeNextRun: true });
    }
    const hostAfter = captureHostState();
    assertHostStateUnchanged(hostBefore, hostAfter);
    evidence = {
      goal: 'self-host-data-safety',
      result: 'pass',
      baseline,
      platform: {
        claim: 'Linux Native only',
        kernel: release(),
        architecture: arch(),
        node: process.version,
        bun: runChecked(bun, ['--version'], { label: 'bun-version' }).stdout.trim(),
      },
      artifacts: built.ledger,
      consecutiveRuns: runs,
      hostState: {
        unchanged: true,
        realSettings: hostAfter.realSettings,
        realHappyRootEntryCount: hostAfter.realHappyRoot.entries?.length || 0,
        globalNpmRoot: hostAfter.globalNpmRoot,
        globalNpmEntriesUnchanged: true,
        runningDaemonCount: hostAfter.daemons.length,
      },
      cleanup: { taskProcessesBeforeRemoval: 0 },
    };
  } catch (error) {
    failure = error;
  } finally {
    if (activeProcessGroup) {
      await terminateProcessGroup(activeProcessGroup);
      activeProcessGroup = undefined;
    }
    const remaining = taskProcesses(taskRoot);
    if (remaining.length > 0 && !failure) {
      failure = new Error(`Task-owned processes remained before cleanup: ${JSON.stringify(remaining)}`);
    }
    if (existsSync(taskRoot)) rmSync(assertOwnedTaskRoot(taskRoot), { recursive: true, force: true });
    activeTaskRoot = undefined;
  }
  if (failure) throw failure;
  evidence.cleanup.taskRootRemoved = !existsSync(taskRoot);
  assert.equal(evidence.cleanup.taskRootRemoved, true);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const workerIndex = process.argv.indexOf('--worker');
  const operation = workerIndex === -1
    ? parentMain(process.argv.slice(2))
    : workerMain(process.argv[workerIndex + 1]);
  operation.catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
